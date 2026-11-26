import { XMLParser, XMLValidator } from 'fast-xml-parser'
import ICAL from 'ical.js'
import { configured, database, digest, isOwner, json, sealToken, tokenContext, type Env } from './backend.ts'
import { normalizeEvent } from './import.ts'
import { ProviderError } from './providers.ts'

const entry = 'https://caldav.icloud.com/'
const namespaces = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'
const parser = new XMLParser({
  removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, trimValues: false,
})

interface DavProperties {
  'current-user-principal'?: { href: string }
  'calendar-home-set'?: { href: string | string[] }
  resourcetype?: { calendar?: unknown }
  'supported-calendar-component-set'?: { comp: { '@_name': string } | { '@_name': string }[] }
  'calendar-data'?: string | { '#text': string }
}

interface DavResource {
  href: string
  status?: string
  propstat?: { status: string; prop: DavProperties } | { status: string; prop: DavProperties }[]
}

interface AppleCredential {
  email: string
  password: string
}

function collection<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function appleUrl(href: string, base = entry) {
  const url = new URL(href.trim(), base)
  if (url.protocol !== 'https:' || !/^(?:p\d+-)?caldav\.icloud\.com$/.test(url.hostname) ||
    url.port || url.username || url.password || url.hash) throw new Error('Unexpected CalDAV destination')
  return url
}

function successful(status?: string) {
  return typeof status === 'string' && /^HTTP\/\d(?:\.\d)? 2\d\d(?:\s|$)/.test(status.trim())
}

class CalDAV {
  private requests = 0
  private readonly deadline = AbortSignal.timeout(120_000)
  private readonly authorization: string

  constructor({ email, password }: AppleCredential) {
    this.authorization = 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(email + ':' + password)))
  }

  async read(url: URL, method: 'PROPFIND' | 'REPORT', depth: '0' | '1', body: string) {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (++this.requests > 40) throw new Error('Calendar request limit exceeded')
      const result = await fetch(url, {
        method, body, redirect: 'manual',
        headers: { authorization: this.authorization, depth, 'content-type': 'application/xml; charset=utf-8' },
        signal: AbortSignal.any([this.deadline, AbortSignal.timeout(15_000)]),
      })
      if ([301, 302, 307, 308].includes(result.status)) {
        const location = result.headers.get('location')
        if (!location) throw new Error('CalDAV redirect is incomplete')
        url = appleUrl(location, url.href)
        continue
      }
      if (result.status !== 207) throw new ProviderError(result.status === 401)
      const xml = await result.text()
      if (xml.length > 3_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Unsupported CalDAV response')
      const parsed: { multistatus?: { response?: DavResource | DavResource[] } | string } = parser.parse(xml)
      if (!Object.hasOwn(parsed, 'multistatus')) throw new Error('Invalid CalDAV response')
      const root = parsed.multistatus
      if (typeof root === 'string' && root.trim()) throw new Error('Invalid CalDAV response')
      const resources = root && typeof root === 'object' ? collection(root.response) : []
      return { url, resources }
    }
    throw new Error('CalDAV redirect limit exceeded')
  }

  props(url: URL, depth: '0' | '1', fields: string) {
    return this.read(url, 'PROPFIND', depth, `<d:propfind ${namespaces}><d:prop>${fields}</d:prop></d:propfind>`)
  }

  async principal() {
    const result = await this.props(appleUrl(entry), '0', '<d:current-user-principal/>')
    const href = successfulProperties(result.resources).flatMap(prop =>
      typeof prop['current-user-principal']?.href === 'string' ? [prop['current-user-principal'].href] : [],
    )[0]
    if (!href) throw new Error('CalDAV principal not found')
    return appleUrl(href, result.url.href)
  }

  async calendars() {
    const principal = await this.principal()
    const homes = await this.props(principal, '0', '<c:calendar-home-set/>')
    const hrefs = successfulProperties(homes.resources).flatMap(prop => collection(prop['calendar-home-set']?.href))
    if (!hrefs.length) throw new Error('CalDAV calendar home not found')
    const calendars = new Set<string>()
    for (const href of hrefs) {
      const home = appleUrl(href, homes.url.href)
      const listing = await this.props(home, '1', '<d:resourcetype/><c:supported-calendar-component-set/>')
      if (!listing.resources.length) throw new Error('CalDAV calendar home is unreadable')
      for (const resource of listing.resources) {
        const properties = successfulProperties([resource])
        if (!properties.some(prop => Object.hasOwn(prop, 'resourcetype'))) {
          throw new Error('CalDAV calendar listing is incomplete')
        }
        for (const prop of properties) {
          if (!prop.resourcetype || !Object.hasOwn(prop.resourcetype, 'calendar')) continue
          const components = collection(prop['supported-calendar-component-set']?.comp)
          if (components.length && !components.some(comp => comp['@_name'] === 'VEVENT')) continue
          calendars.add(appleUrl(resource.href, listing.url.href).href)
        }
      }
    }
    return [...calendars]
  }
}

function successfulProperties(resources: DavResource[]) {
  return resources.flatMap(resource => {
    if (resource.status && !successful(resource.status)) throw new Error('CalDAV resource is unreadable')
    return collection(resource.propstat).filter(item => successful(item.status)).map(item => item.prop)
  })
}

function dateValue(time: InstanceType<typeof ICAL.Time>) {
  if (time.isDate) return { date: time.toString() }
  if (time.zone.tzid === 'floating') throw new Error('CalDAV event time zone is missing')
  return { dateTime: time.toJSDate().toISOString() }
}

export async function appleSnapshot(credential: AppleCredential, start: string, end: string) {
  const client = new CalDAV(credential)
  const compact = (date: string) => date.replace(/[-:]|\.\d+/g, '')
  const range = `start="${compact(start)}" end="${compact(end)}"`
  const report = `<c:calendar-query ${namespaces}>
    <d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>
    <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
      <c:time-range ${range}/>
    </c:comp-filter></c:comp-filter></c:filter>
  </c:calendar-query>`
  const calendars = await client.calendars()
  if (calendars.length > 24) throw new Error('Calendar count limit exceeded')
  const events = new Map<string, NonNullable<ReturnType<typeof normalizeEvent>>>()
  for (const calendar of calendars) {
    const { resources } = await client.read(appleUrl(calendar), 'REPORT', '1', report)
    const calendarId = new URL(calendar).pathname
    for (const resource of resources) {
      const props = successfulProperties([resource]).map(prop => prop['calendar-data']).filter(Boolean)
      if (props.length !== 1) throw new Error('CalDAV calendar object is unreadable')
      const value = props[0]
      const data = typeof value === 'string' ? value : value?.['#text']
      if (!data) throw new Error('CalDAV calendar data is missing')
      const component = new ICAL.Component(ICAL.parse(data.trim()))
      for (const item of component.getAllSubcomponents('vevent')) {
        const event = new ICAL.Event(item)
        if (String(item.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') continue
        if (event.isRecurring() || !event.uid) throw new Error('CalDAV event was not expanded')
        const id = JSON.stringify([event.uid, event.recurrenceId?.toString() ?? null])
        const normalized = normalizeEvent('apple', calendarId, {
          id, iCalUID: event.uid, summary: event.summary,
          start: dateValue(event.startDate), end: dateValue(event.endDate),
          visibility: String(item.getFirstPropertyValue('class')).toLowerCase(),
          transparency: String(item.getFirstPropertyValue('transp')).toLowerCase(),
        })
        if (normalized) events.set(JSON.stringify([calendarId, id]), normalized)
        if (events.size > 4000) throw new Error('Calendar event limit exceeded')
      }
    }
  }
  return [...events.values()]
}

export async function connectApple(request: Request, env: Env) {
  const url = new URL(request.url)
  if (!configured(env) || env.APPLE_CALDAV_ENABLED !== 'true' || url.origin !== env.APP_ORIGIN || url.protocol !== 'https:') {
    return json({ error: 'iCloud enrollment is unavailable.' }, 503)
  }
  if (request.headers.get('origin') !== env.APP_ORIGIN) return json({ error: 'Invalid origin.' }, 403)
  try {
    if (!await isOwner(request, env)) return json({ error: 'Owner sign-in required.' }, 401)
    const raw = await request.text()
    if (raw.length > 1024) return json({ error: 'Invalid iCloud credentials.' }, 400)
    let input
    try {
      input = JSON.parse(raw)
    } catch {
      return json({ error: 'Invalid iCloud credentials.' }, 400)
    }
    const email = typeof input?.email === 'string' ? input.email.trim() : ''
    const password = typeof input?.password === 'string' ? input.password.trim() : ''
    if (!/^[^@\s:]+@[^@\s:]+$/.test(email) || !/^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(password)) {
      return json({ error: 'An Apple Account email and app-specific password are required.' }, 400)
    }
    const credential = { email, password }
    const principal = await new CalDAV(credential).principal()
    const accountId = await digest(principal.pathname.replace(/\/$/, ''))
    await database(env, 'rpc/save_calendar_connection', 'POST', {
      owner_id: env.OWNER_USER_ID, source: 'apple', remote_account: accountId,
      sealed_token: await sealToken(
        env.CALENDAR_TOKEN_KEY!, tokenContext(env.OWNER_USER_ID!, 'apple', accountId), JSON.stringify(credential),
      ),
    })
    return json({ status: 'connected' })
  } catch (error) {
    const rejected = error instanceof ProviderError && error.reauthorize
    return json({ error: 'Could not connect to iCloud.' }, rejected ? 422 : 502)
  }
}
