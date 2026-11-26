import {
  configured, database, digest, isOwner, json, privateHeaders, randomToken, sealToken, tokenContext,
  type Env,
} from './backend.ts'
import { exchange, oauthConfig, providerGet, type OAuthProvider } from './providers.ts'

const cookieName = '__Host-calendar-oauth'

function browserCookie(state: string, maxAge: number) {
  return `${cookieName}=${state}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`
}

function complete(outcome: 'connected' | 'declined' | 'failed') {
  return new Response(null, { status: 303, headers: {
    ...privateHeaders, location: `/?calendar=${outcome}`, 'set-cookie': browserCookie('', 0),
  } })
}

export async function calendarOAuth(request: Request, env: Env, provider: OAuthProvider, step: string) {
  const url = new URL(request.url)
  if (!configured(env) || url.origin !== env.APP_ORIGIN || url.protocol !== 'https:') {
    return json({ error: 'Calendar onboarding is unavailable.' }, 503)
  }
  const config = oauthConfig(provider, env)
  if (!config.clientId || !config.clientSecret) return json({ error: 'Provider setup is pending.' }, 503)
  const redirectUri = `${env.APP_ORIGIN}/api/calendar/oauth/${provider}/callback`

  if (step === 'start' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.APP_ORIGIN) return json({ error: 'Invalid origin.' }, 403)
    if (!await isOwner(request, env)) return json({ error: 'Owner sign-in required.' }, 401)
    const state = randomToken()
    const verifier = randomToken()
    await database(env, 'calendar_oauth_requests', 'POST', {
      state_hash: await digest(state), user_id: env.OWNER_USER_ID, provider, verifier,
    })
    const authorize = new URL(config.authorize)
    authorize.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: redirectUri,
      response_type: 'code', scope: config.scopes, state,
      ...(config.pkce ? { code_challenge: await digest(verifier), code_challenge_method: 'S256' } : {}),
      ...config.options,
    }).toString()
    const response = json({ url: authorize.href })
    response.headers.set('set-cookie', browserCookie(state, 600))
    return response
  }

  if (step === 'callback' && request.method === 'GET') {
    const state = url.searchParams.get('state')
    const nonce = request.headers.get('cookie')?.split(/;\s*/).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    if (!state || !/^[\w-]{43}$/.test(state) || state !== nonce) {
      return json({ error: 'This connection request expired. Return to CalendarIntel and try again.' }, 400)
    }
    try {
      const [pending] = await database<{ user_id: string; verifier: string }[]>(env, 'rpc/consume_calendar_oauth', 'POST', {
        request_hash: await digest(state), requested_provider: provider,
      })
      if (!pending || pending.user_id !== env.OWNER_USER_ID) return complete('failed')
      if (url.searchParams.has('error')) return complete('declined')
      const code = url.searchParams.get('code')
      if (!code) return complete('failed')
      if (provider === 'zoho' && url.searchParams.get('location') !== (env.ZOHO_REGION ?? 'us')) return complete('failed')
      const { accessToken, refreshToken } = await exchange(config, {
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        ...(config.pkce ? { code_verifier: pending.verifier } : {}),
      })
      if (!refreshToken) return complete('failed')
      const profile = await providerGet<{ sub?: string; id?: string; calendars?: { owner: string }[] }>(
        config.profile, accessToken,
      )
      const zohoOwner = profile.calendars?.[0]?.owner
      const accountId = provider === 'google' ? profile.sub : provider === 'microsoft' ? profile.id
        : typeof zohoOwner === 'string' && zohoOwner ? (env.ZOHO_REGION ?? 'us') + ':' + zohoOwner : undefined
      if (typeof accountId !== 'string' || !accountId) return complete('failed')
      await database(env, 'rpc/save_calendar_connection', 'POST', {
        owner_id: pending.user_id, source: provider, remote_account: accountId,
        sealed_token: await sealToken(env.CALENDAR_TOKEN_KEY!, tokenContext(pending.user_id, provider, accountId), refreshToken),
      })
      return complete('connected')
    } catch {
      return complete('failed')
    }
  }

  return json({ error: 'Method not allowed.' }, 405)
}
