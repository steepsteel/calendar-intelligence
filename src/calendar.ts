export const providerLabels = {
  google: 'Google Calendar',
  microsoft: 'Microsoft 365',
  apple: 'Apple iCloud',
  zoho: 'Zoho Calendar',
} as const

export type Provider = keyof typeof providerLabels

const consumerDomains = new Map<string, Provider>([
  ['gmail.com', 'google'], ['googlemail.com', 'google'],
  ['outlook.com', 'microsoft'], ['hotmail.com', 'microsoft'], ['live.com', 'microsoft'],
  ['icloud.com', 'apple'], ['me.com', 'apple'], ['mac.com', 'apple'],
  ['zoho.com', 'zoho'], ['zohomail.com', 'zoho'],
])

export function detectProvider(email: string): Provider | undefined {
  const match = /^[^@\s]+@([^@\s]+)$/.exec(email.trim())
  return match ? consumerDomains.get(match[1].toLowerCase()) : undefined
}

export interface CalendarEvent {
  id: string
  provider: Provider
  ical_uid: string | null
  title: string | null
  starts_at: string
  ends_at: string
  busy: boolean
  all_day: boolean
  private: boolean
}

export function analyzeAgenda(events: readonly CalendarEvent[]) {
  const entries = new Map<string, {
    event: CalendarEvent
    sources: Set<Provider>
    start: number
    end: number
    busy: boolean
    private: boolean
  }>()

  for (const event of events) {
    const start = Date.parse(event.starts_at)
    const end = Date.parse(event.ends_at)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue

    // Recurrences may share a UID, so include the occurrence start.
    const key = event.ical_uid
      ? JSON.stringify([event.ical_uid, start, event.all_day])
      : JSON.stringify([event.id])
    const entry = entries.get(key)
    if (entry) {
      entry.sources.add(event.provider)
      entry.busy ||= event.busy
      entry.private ||= event.private
      entry.end = Math.max(entry.end, end)
      continue
    }
    entries.set(key, {
      event, sources: new Set([event.provider]), start, end,
      busy: event.busy, private: event.private,
    })
  }

  const agenda = [...entries.entries()].sort((a, b) => a[1].start - b[1].start)
  const conflicts = new Set<string>()
  let latestBusy: { key: string; end: number } | undefined
  for (const [key, entry] of agenda) {
    if (!entry.busy) continue
    if (latestBusy && entry.start < latestBusy.end) {
      conflicts.add(key)
      conflicts.add(latestBusy.key)
    }
    if (!latestBusy || entry.end > latestBusy.end) latestBusy = { key, end: entry.end }
  }

  return agenda.map(([key, entry]) => ({
    key,
    ...entry,
    title: entry.private ? 'Private event' : (entry.event.title || 'Untitled event'),
    conflict: conflicts.has(key),
  }))
}
