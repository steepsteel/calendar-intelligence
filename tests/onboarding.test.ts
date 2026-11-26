import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../worker/index.ts'
import { digest, openToken, randomToken, sealToken, tokenContext } from '../worker/backend.ts'
import { calendarSnapshot, normalizeEvent } from '../worker/import.ts'

const origin = 'https://calendarintel.test'

test('owner OAuth requires a same-origin request and returns provider consent bound to this browser', async (t) => {
  const owner = '1234'
  const env = {
    ASSETS: { fetch: async () => new Response(null) },
    APP_ORIGIN: origin, OWNER_USER_ID: owner, SUPABASE_URL: 'https://db.test',
    SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'secret',
    CALENDAR_TOKEN_KEY: randomToken(), GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'google-secret',
  }
  let pending: { state_hash: string; verifier: string } | undefined
  let sealed: string | undefined
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/auth/v1/user') {
      return Response.json({ id: new Headers(init?.headers).get('authorization') === 'Bearer owner' ? owner : 'other' })
    }
    if (url.pathname === '/rest/v1/calendar_oauth_requests') {
      pending = JSON.parse(String(init?.body))
      return new Response(null, { status: 201 })
    }
    if (url.pathname === '/rest/v1/rpc/consume_calendar_oauth') {
      const body = JSON.parse(String(init?.body))
      if (!pending || body.request_hash !== pending.state_hash || body.requested_provider !== 'google') {
        return Response.json([])
      }
      const response = Response.json([{ user_id: owner, verifier: pending.verifier }])
      pending = undefined
      return response
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.equal(new URLSearchParams(String(init?.body)).get('code'), 'synthetic-code')
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ sub: 'provider-account' })
    }
    assert.equal(url.pathname, '/rest/v1/rpc/save_calendar_connection')
    sealed = JSON.parse(String(init?.body)).sealed_token
    return new Response(null, { status: 204 })
  })
  const start = (from: string, auth: string) => worker.fetch(new Request(origin + '/api/calendar/oauth/google/start', {
    method: 'POST', headers: { origin: from, authorization: 'Bearer ' + auth },
  }), env)
  assert.equal((await start('https://other.test', 'owner')).status, 403)
  assert.equal(fetchMock.mock.calls.length, 0)
  assert.equal((await start(origin, 'another user')).status, 401)
  const result = await start(origin, 'owner')
  assert.equal(result.status, 200)
  const cookie = result.headers.get('set-cookie')!
  assert.match(cookie, /Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax/)
  const authorization = new URL((await result.json()).url)
  assert.equal(authorization.origin, 'https://accounts.google.com')
  const state = authorization.searchParams.get('state')!
  assert.equal(pending?.state_hash, await digest(state))
  assert.equal(authorization.searchParams.get('code_challenge'), await digest(pending!.verifier))
  assert.match(authorization.searchParams.get('scope')!, /calendar\.readonly/)
  const callback = (browserCookie?: string) => worker.fetch(new Request(origin +
    '/api/calendar/oauth/google/callback?' + new URLSearchParams({ state, code: 'synthetic-code' }),
  { headers: browserCookie ? { cookie: browserCookie } : {} }), env)
  assert.equal((await callback()).status, 400)
  assert.equal((await callback(cookie.split(';')[0])).headers.get('location'), '/?calendar=connected')
  assert.equal((await callback(cookie.split(';')[0])).headers.get('location'), '/?calendar=failed')
  assert.equal(await openToken(env.CALENDAR_TOKEN_KEY, tokenContext(owner, 'google', 'provider-account'), sealed!),
    'synthetic-refresh')
})

test('sealed credentials use unique nonces and cannot be moved between accounts', async () => {
  const key = randomToken()
  const token = await sealToken(key, 'account A', 'refresh token')
  assert.notEqual(token, await sealToken(key, 'account A', 'refresh token'))
  assert.equal(await openToken(key, 'account A', token), 'refresh token')
  await assert.rejects(openToken(key, 'account B', token))
  await assert.rejects(openToken(randomToken(), 'account A', token))
})

test('event normalization ignores cancellations and never stores private titles', () => {
  const event = {
    id: 'event', subject: 'private title', sensitivity: 'private', showAs: 'free',
    start: { dateTime: '2026-11-26T13:00:00.0000000' }, end: { dateTime: '2026-11-26T14:00:00.0000000' },
  }
  const result = normalizeEvent('microsoft', 'calendar', event)
  assert.equal(result?.title, null)
  assert.equal(result?.busy, false)
  assert.equal(result?.starts_at, '2026-11-26T13:00:00.000Z')
  assert.equal(normalizeEvent('google', 'calendar', { id: 'cancelled', status: 'cancelled' }), null)
})

test('Google imports all pages and Graph rejects a cross-origin continuation', async (t) => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    calls.push(url.href)
    if (url.hostname === 'graph.microsoft.com') {
      return Response.json({ value: [], '@odata.nextLink': 'https://other.test/calendar' })
    }
    if (url.pathname.endsWith('/calendarList')) {
      return Response.json({ kind: 'calendar#calendarList', items: [{ id: 'primary' }] })
    }
    const item = {
      id: url.searchParams.get('pageToken') ? 'two' : 'one',
      start: { dateTime: '2026-11-26T13:00:00Z' }, end: { dateTime: '2026-11-26T14:00:00Z' },
    }
    return Response.json({
      kind: 'calendar#events', items: [item],
      ...(item.id === 'one' ? { nextPageToken: 'next' } : {}),
    })
  })
  const start = '2026-11-26T00:00:00Z'
  const end = '2026-12-01T00:00:00Z'
  const events = await calendarSnapshot('google', 'fake-token', start, end)
  assert.deepEqual(events.map(event => event.provider_event_id), ['one', 'two'])
  await assert.rejects(calendarSnapshot('microsoft', 'fake-token', start, end), /Invalid calendar continuation/)
  assert.equal(calls.length, 4)
  assert.equal(calls.some(url => url.startsWith('https://other.test')), false)
})

test('watch probe is opt-in, uncached, and returns data from the current request', async () => {
  const request = new Request(origin + '/api/watch/probe')
  const env = { ASSETS: { fetch: async () => new Response(null) }, APP_ORIGIN: origin }
  assert.equal((await worker.fetch(request, env)).status, 404)
  const enabled = { ...env, WATCH_PROBE_ENABLED: 'true' }
  const first = await worker.fetch(request, enabled)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  const second = await worker.fetch(request, enabled)
  assert.notEqual((await first.json()).id, (await second.json()).id)
})

test('Zoho reads from the configured data center and preserves recurring instances and privacy', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://calendar.zoho.eu')
    if (url.pathname === '/api/v1/calendars') {
      return Response.json({ calendars: [{ uid: 'calendar' }] })
    }
    assert.equal(url.searchParams.get('byinstance'), 'true')
    assert.deepEqual(JSON.parse(url.searchParams.get('range')!), {
      start: '20261126T000000Z', end: '20261201T000000Z',
    })
    return Response.json({ events: [26, 27].map(day => ({
      uid: 'one-series', isprivate: true, title: 'Synthetic private title',
      dateandtime: { start: `202611${day}T130000+0530`, end: `202611${day}T140000+0530` },
    })) })
  })
  const events = await calendarSnapshot('zoho', 'fake-token', '2026-11-26T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'eu')
  assert.equal(events.length, 2)
  assert.equal(events[0].starts_at, '2026-11-26T07:30:00.000Z')
  assert.notEqual(events[0].provider_event_id, events[1].provider_event_id)
  assert.ok(events.every(event => event.ical_uid === 'one-series' && event.private && event.title === null))
})
