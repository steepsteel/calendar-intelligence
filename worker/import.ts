import type { Provider } from '../src/calendar.ts'
import { providerGet, zohoEndpoints, type OAuthProvider } from './providers.ts'

const googleBase = 'https://www.googleapis.com/calendar/v3'
const graphBase = 'https://graph.microsoft.com/v1.0'
const graphHeaders = { prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' }

interface Item {
  id: string
  iCalUID?: string
  iCalUId?: string
  summary?: string
  subject?: string
  status?: string
  isCancelled?: boolean
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  transparency?: string
  visibility?: string
  sensitivity?: string
  showAs?: string
  isAllDay?: boolean
}

export function normalizeEvent(provider: Provider, calendarId: string, event: Item) {
  if (event.status === 'cancelled' || event.isCancelled) return null
  const start = event.start?.dateTime || event.start?.date
  const end = event.end?.dateTime || event.end?.date
  if (!event.id || !start || !end) throw new Error('Incomplete calendar event')
  // Graph returns offset-free dateTime with the time zone specified by Prefer.
  const parse = (value: string) => Date.parse(provider === 'microsoft' && !/Z$|[+-]\d\d:\d\d$/i.test(value)
    ? value + 'Z' : value)
  const startsAt = parse(start)
  const endsAt = parse(end)
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw new Error('Invalid event dates')
  if (startsAt >= endsAt) return null
  const isPrivate = ['private', 'confidential'].includes(event.visibility ?? event.sensitivity ?? '')
  return {
    calendar_id: calendarId,
    provider_event_id: event.id,
    ical_uid: event.iCalUID ?? event.iCalUId ?? null,
    title: isPrivate ? null : (event.summary ?? event.subject ?? null),
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
    busy: event.transparency !== 'transparent' && event.showAs !== 'free',
    all_day: Boolean(event.start?.date || event.isAllDay),
    private: isPrivate,
  }
}

function withParams(base: string, params: Record<string, string>) {
  return base + '?' + new URLSearchParams(params)
}

type ReadPage = <T>(url: string, headers?: Record<string, string>) => Promise<T>

async function* googlePages<T>(url: string, read: ReadPage) {
  const pageUrl = new URL(url)
  for (let count = 0; count < 15; count++) {
    const page = await read<{ kind: string; items?: T[]; nextPageToken?: string }>(pageUrl.href)
    if (!['calendar#calendarList', 'calendar#events'].includes(page.kind) ||
      (page.items !== undefined && !Array.isArray(page.items))) throw new Error('Invalid calendar response')
    yield page.items ?? []
    if (!page.nextPageToken) return
    pageUrl.searchParams.set('pageToken', page.nextPageToken)
  }
  throw new Error('Calendar pagination limit exceeded')
}

async function* graphPages<T>(initial: string, read: ReadPage) {
  let url = initial
  for (let count = 0; count < 15; count++) {
    const next = new URL(url)
    if (next.origin !== 'https://graph.microsoft.com' || next.username || next.password ||
      !next.pathname.startsWith('/v1.0/')) throw new Error('Invalid calendar continuation')
    const page = await read<{ value: T[]; '@odata.nextLink'?: string }>(next.href, graphHeaders)
    if (!Array.isArray(page.value)) throw new Error('Invalid calendar response')
    yield page.value
    if (!page['@odata.nextLink']) return
    url = page['@odata.nextLink']
  }
  throw new Error('Calendar pagination limit exceeded')
}

interface ZohoItem {
  uid: string
  title?: string
  isallday?: boolean
  isprivate?: boolean
  start?: string
  end?: string
  dateandtime?: { start?: string; end?: string }
  status?: string
  transparency?: string
}

function parseZohoDate(value: string | undefined, dateOnly: boolean) {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/)
  if (!match) return {}
  const [, year, month, day, hour, minute, second, offset] = match
  const date = `${year}-${month}-${day}`
  if (dateOnly) return { date }
  if (!hour) return {}
  const zone = offset && offset !== 'Z' ? offset.slice(0, 3) + ':' + offset.slice(3) : 'Z'
  return { dateTime: `${date}T${hour}:${minute}:${second}${zone}` }
}

async function* zohoCalendars(read: ReadPage, base: string) {
  const data = await read<{ calendars: { uid: string; privilege?: string }[] }>(base + '/calendars?category=all')
  if (!Array.isArray(data.calendars)) throw new Error('Invalid Zoho calendar response')
  yield data.calendars.filter(calendar => calendar.privilege?.toLowerCase() !== 'freebusy')
    .map(calendar => ({ id: calendar.uid }))
}

async function* zohoEvents(read: ReadPage, base: string, id: string, start: string, end: string) {
  const compact = (date: string) => date.replace(/[-:]|\.\d+/g, '')
  const data = await read<{ events: ZohoItem[] }>(withParams(base + '/calendars/' + id + '/events', {
    range: JSON.stringify({ start: compact(start), end: compact(end) }),
    byinstance: 'true', timezone: 'UTC',
  }))
  if (!Array.isArray(data.events)) throw new Error('Invalid Zoho event response')
  yield data.events.map(event => {
    if (!event.uid || typeof event.uid !== 'string') throw new Error('Invalid Zoho event ID')
    const starts = parseZohoDate(event.dateandtime?.start ?? event.start, Boolean(event.isallday))
    return {
      id: JSON.stringify([event.uid, starts.dateTime ?? starts.date]),
      iCalUID: event.uid,
      summary: event.title,
      start: starts,
      end: parseZohoDate(event.dateandtime?.end ?? event.end, Boolean(event.isallday)),
      status: event.status?.toLowerCase(),
      visibility: event.isprivate ? 'private' : undefined,
      transparency: event.transparency?.toLowerCase(),
    }
  })
}

export async function calendarSnapshot(
  provider: OAuthProvider, token: string, start: string, end: string, zohoRegion?: string,
) {
  const deadline = AbortSignal.timeout(120_000)
  let requests = 0
  const read: ReadPage = (url, headers) => {
    if (++requests > 40) throw new Error('Calendar request limit exceeded')
    return providerGet(url, token, headers, deadline)
  }
  const events = new Map<string, NonNullable<ReturnType<typeof normalizeEvent>>>()
  const google = provider === 'google'
  const zoho = provider === 'zoho' ? zohoEndpoints(zohoRegion).calendar : null
  const calendars = google
    ? googlePages<{ id: string; accessRole?: string }>(withParams(googleBase + '/users/me/calendarList', {
        maxResults: '250', fields: 'kind,nextPageToken,items(id,accessRole)',
      }), read)
    : zoho ? zohoCalendars(read, zoho) : graphPages<{ id: string }>(graphBase + '/me/calendars?$select=id', read)
  let scanned = 0

  for await (const page of calendars) {
    for (const calendar of page) {
      if ('accessRole' in calendar && calendar.accessRole === 'freeBusyReader') continue
      if (++scanned > 24) throw new Error('Calendar count limit exceeded')
      if (typeof calendar.id !== 'string' || !calendar.id) throw new Error('Invalid calendar ID')
      const id = encodeURIComponent(calendar.id)
      const pages = google
        ? googlePages<Item>(withParams(googleBase + '/calendars/' + id + '/events', {
            timeMin: start, timeMax: end, singleEvents: 'true', maxResults: '500',
            fields: 'kind,nextPageToken,items(id,iCalUID,summary,status,start,end,transparency,visibility)',
          }), read)
        : zoho ? zohoEvents(read, zoho, id, start, end) : graphPages<Item>(withParams(graphBase + '/me/calendars/' + id + '/calendarView', {
            startDateTime: start, endDateTime: end,
            $select: 'id,iCalUId,subject,start,end,isAllDay,isCancelled,sensitivity,showAs', $top: '500',
          }), read)
      for await (const batch of pages) {
        for (const event of batch) {
          const normalized = normalizeEvent(provider, calendar.id, event)
          if (!normalized) continue
          events.set(JSON.stringify([calendar.id, event.id]), normalized)
          if (events.size > 4000) throw new Error('Calendar event limit exceeded')
        }
      }
    }
  }
  return [...events.values()]
}
