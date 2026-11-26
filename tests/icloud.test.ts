import assert from 'node:assert/strict'
import test from 'node:test'
import { appleSnapshot } from '../worker/icloud.ts'

const credential = { email: 'example@icloud.test', password: 'aaaa-bbbb-cccc-dddd' }
const start = '2026-11-26T00:00:00.000Z'
const end = '2026-12-01T00:00:00.000Z'

function resource(href: string, contents: string) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${contents}</d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

function dav(resources: string) {
  return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    ${resources}</d:multistatus>`, { status: 207 })
}

test('iCloud discovers Apple calendars and imports expanded events with read-only CalDAV requests', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push(init.method!)
    assert.ok(new Headers(init.headers).get('authorization')?.startsWith('Basic '))
    assert.equal(init.redirect, 'manual')
    if (url.hostname === 'caldav.icloud.com') {
      return new Response(null, {
        status: 301, headers: { location: 'https://p01-caldav.icloud.com/' },
      })
    }
    assert.equal(url.hostname, 'p01-caldav.icloud.com')
    if (url.pathname === '/') {
      return dav(resource('/', '<d:current-user-principal><d:href>/account/principal/</d:href></d:current-user-principal>'))
    }
    if (url.pathname === '/account/principal/') {
      return dav(resource(url.pathname, '<c:calendar-home-set><d:href>/account/calendars/</d:href></c:calendar-home-set>'))
    }
    if (url.pathname === '/account/calendars/') {
      return dav(resource(url.pathname, '<d:resourcetype><d:collection/></d:resourcetype>') +
        resource('/account/calendars/work/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'))
    }
    assert.equal(init.method, 'REPORT')
    assert.match(String(init.body), /<c:expand start="20261126T000000Z" end="20261201T000000Z"\/>/)
    const events = ['26', '27'].map(day => [
      'BEGIN:VEVENT', 'UID:series', `RECURRENCE-ID:202611${day}T120000Z`, `DTSTART:202611${day}T120000Z`,
      `DTEND:202611${day}T130000Z`, 'CLASS:PRIVATE', 'SUMMARY:Hidden private event', 'END:VEVENT',
    ].join('\r\n')).join('\r\n')
    return dav(resource(url.pathname + 'series.ics',
      `<c:calendar-data><![CDATA[BEGIN:VCALENDAR\r\n${events}\r\nEND:VCALENDAR]]></c:calendar-data>`))
  })
  const events = await appleSnapshot(credential, start, end)
  assert.deepEqual(calls, ['PROPFIND', 'PROPFIND', 'PROPFIND', 'PROPFIND', 'REPORT'])
  assert.equal(events.length, 2)
  assert.notEqual(events[0].provider_event_id, events[1].provider_event_id)
  assert.ok(events.every(event => event.private && event.title === null))
})

test('iCloud never sends credentials to an untrusted redirect', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 301, headers: { location: 'https://caldav.icloud.com.other.test/' },
  }))
  await assert.rejects(appleSnapshot(credential, start, end), /Unexpected CalDAV destination/)
  assert.equal(request.mock.calls.length, 1)
})
