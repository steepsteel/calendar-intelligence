import type { Env } from './backend.ts'

export type OAuthProvider = 'google' | 'microsoft' | 'zoho'

const zohoSuffixes = new Map([
  ['us', 'com'], ['eu', 'eu'], ['in', 'in'], ['au', 'com.au'], ['cn', 'com.cn'],
])

export function enabledOAuthProviders(env: Env): OAuthProvider[] {
  const providers: OAuthProvider[] = []
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) providers.push('google')
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) providers.push('microsoft')
  if (env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && zohoSuffixes.has(env.ZOHO_REGION ?? 'us')) providers.push('zoho')
  return providers
}

export function zohoEndpoints(region = 'us') {
  const suffix = zohoSuffixes.get(region)
  if (!suffix) throw new Error('Unsupported Zoho region')
  return { accounts: `https://accounts.zoho.${suffix}`, calendar: `https://calendar.zoho.${suffix}/api/v1` }
}

interface OAuthConfig {
  clientId?: string
  clientSecret?: string
  authorize: string
  token: string
  profile: string
  scopes: string
  pkce: boolean
  options: Record<string, string>
}

export function oauthConfig(provider: OAuthProvider, env: Env): OAuthConfig {
  if (provider === 'zoho') {
    const { accounts, calendar } = zohoEndpoints(env.ZOHO_REGION)
    return {
      clientId: env.ZOHO_CLIENT_ID,
      clientSecret: env.ZOHO_CLIENT_SECRET,
      authorize: accounts + '/oauth/v2/auth',
      token: accounts + '/oauth/v2/token',
      profile: calendar + '/calendars/default',
      scopes: 'ZohoCalendar.calendar.READ,ZohoCalendar.event.READ',
      pkce: false,
      options: { access_type: 'offline', prompt: 'consent' },
    }
  }
  if (provider === 'google') {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      profile: 'https://openidconnect.googleapis.com/v1/userinfo',
      scopes: 'openid https://www.googleapis.com/auth/calendar.readonly',
      pkce: true,
      options: { access_type: 'offline', prompt: 'consent select_account' },
    }
  }
  const base = 'https://login.microsoftonline.com/common/oauth2/v2.0'
  return {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    authorize: base + '/authorize',
    token: base + '/token',
    profile: 'https://graph.microsoft.com/v1.0/me?$select=id',
    scopes: 'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read',
    pkce: true,
    options: { prompt: 'select_account' },
  }
}

export class ProviderError extends Error {
  readonly reauthorize: boolean
  readonly retrySeconds?: number

  constructor(reauthorize: boolean, retrySeconds?: number) {
    super('Calendar provider request failed')
    this.reauthorize = reauthorize
    this.retrySeconds = retrySeconds
  }
}

export async function providerGet<T>(url: string, token: string, headers: Record<string, string> = {}, deadline?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, ...headers },
    redirect: 'error',
    signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout,
  })
  if (!response.ok) {
    const retry = response.headers.get('retry-after')
    const seconds = retry && (Number(retry) || (Date.parse(retry) - Date.now()) / 1000)
    throw new ProviderError(response.status === 401, seconds && seconds > 0 ? Math.ceil(seconds) : undefined)
  }
  return response.json()
}

export async function exchange(
  config: ReturnType<typeof oauthConfig>,
  params: Record<string, string>,
) {
  if (!config.clientId || !config.clientSecret) throw new Error('Provider is unconfigured')
  const response = await fetch(config.token, {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  if (!response.ok || typeof result.access_token !== 'string' || !result.access_token) {
    throw new ProviderError(['invalid_grant', 'invalid_code', 'invalid_refresh_token'].includes(result.error))
  }
  return {
    accessToken: result.access_token as string,
    refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : undefined,
  }
}
