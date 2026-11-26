import { configured, database, isOwner, json, type Env } from './backend.ts'
import { connectApple } from './icloud.ts'
import { enabledOAuthProviders, type OAuthProvider } from './providers.ts'
import { calendarOAuth } from './oauth.ts'
import { scheduledSyncError, syncDueConnection } from './sync.ts'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/health' && request.method === 'GET') return json({ status: 'ok' })
    if (pathname === '/api/watch/probe' && request.method === 'GET' && env.WATCH_PROBE_ENABLED === 'true') {
      return json({ id: crypto.randomUUID(), receivedAt: new Date().toISOString() })
    }
    if (pathname === '/api/calendar/providers' && request.method === 'GET') {
      const url = new URL(request.url)
      if (!configured(env) || url.protocol !== 'https:' || url.origin !== env.APP_ORIGIN) return json({ providers: [] })
      const providers: (OAuthProvider | 'apple')[] = enabledOAuthProviders(env)
      if (env.APPLE_CALDAV_ENABLED === 'true') providers.push('apple')
      return json({ providers })
    }
    if (pathname === '/api/calendar/apple/connect' && request.method === 'POST') {
      return connectApple(request, env)
    }
    const oauth = /^\/api\/calendar\/oauth\/(google|microsoft|zoho)\/(start|callback)$/.exec(pathname)
    if (oauth) {
      try {
        return await calendarOAuth(request, env, oauth[1] as OAuthProvider, oauth[2])
      } catch {
        return json({ error: 'Calendar onboarding could not be started. Try again.' }, 502)
      }
    }
    const control = /^\/api\/calendar\/connections\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/(pause|resume|disconnect)$/.exec(pathname)
    if (control && request.method === 'POST') {
      const url = new URL(request.url)
      if (!configured(env) || url.protocol !== 'https:' || url.origin !== env.APP_ORIGIN) {
        return json({ error: 'Calendar controls are unavailable.' }, 503)
      }
      if (request.headers.get('origin') !== env.APP_ORIGIN) return json({ error: 'Invalid origin.' }, 403)
      try {
        if (!await isOwner(request, env)) return json({ error: 'Owner sign-in required.' }, 401)
        const changed = await database<boolean>(env, 'rpc/control_calendar_connection', 'POST', {
          owner_id: env.OWNER_USER_ID, connection: control[1], operation: control[2],
        })
        return changed ? json({ status: 'ok' }) : json({ error: 'Connection state changed.' }, 409)
      } catch {
        return json({ error: 'Calendar connection could not be updated.' }, 502)
      }
    }
    if (pathname.startsWith('/api/')) return new Response(null, { status: 404 })
    return env.ASSETS.fetch(request)
  },
  scheduled(_event: unknown, env: Env, context: { waitUntil(task: Promise<void>): void }) {
    context.waitUntil(syncDueConnection(env).catch(scheduledSyncError))
  },
}
