import { configured, database, openToken, sealToken, tokenContext, type Env } from './backend.ts'
import { calendarSnapshot } from './import.ts'
import { exchange, oauthConfig, oauthProviders, ProviderError, type OAuthProvider } from './providers.ts'

interface Claim {
  id: string
  user_id: string
  provider: OAuthProvider
  account_id: string
  sealed_refresh_token: string
  sync_lease_id: string
  sync_failures: number
}

export async function syncDueConnection(env: Env) {
  if (!configured(env)) return
  const sources = oauthProviders.filter(provider => {
    const config = oauthConfig(provider, env)
    return Boolean(config.clientId && config.clientSecret)
  })
  if (!sources.length) return
  await database(env, 'calendar_oauth_requests?expires_at=lt.' + encodeURIComponent(new Date().toISOString()), 'DELETE')
  const [claim] = await database<Claim[]>(env, 'rpc/claim_calendar_sync', 'POST', {
    owner_id: env.OWNER_USER_ID, sources,
  })
  if (!claim) return

  const link = { connection: claim.id, lease: claim.sync_lease_id }
  const context = tokenContext(claim.user_id, claim.provider, claim.account_id)
  try {
    if (claim.provider === 'zoho' && !claim.account_id.startsWith((env.ZOHO_REGION ?? 'us') + ':')) {
      throw new ProviderError(true)
    }
    const refreshToken = await openToken(env.CALENDAR_TOKEN_KEY!, context, claim.sealed_refresh_token)
    const { accessToken, refreshToken: rotated } = await exchange(oauthConfig(claim.provider, env), {
      grant_type: 'refresh_token', refresh_token: refreshToken,
    })
    if (rotated && rotated !== refreshToken) {
      const saved = await database<boolean>(env, 'rpc/rotate_calendar_token', 'POST', {
        ...link, sealed_token: await sealToken(env.CALENDAR_TOKEN_KEY!, context, rotated),
      })
      if (!saved) return
    }
    // Include a buffer around the browser's local 14-day agenda on either side.
    const day = 86_400_000
    const start = new Date(Date.now() - 2 * day).toISOString()
    const end = new Date(Date.now() + 16 * day).toISOString()
    const imported = await calendarSnapshot(claim.provider, accessToken, start, end, env.ZOHO_REGION)
    await database(env, 'rpc/finish_calendar_sync', 'POST', {
      ...link, outcome: 'healthy', delay_seconds: 600, window_start: start, window_end: end, imported,
    })
  } catch (error) {
    const failure = error instanceof ProviderError ? error : undefined
    const delay = Math.max(failure?.retrySeconds ?? 0, 300 * 2 ** Math.min(claim.sync_failures, 5))
    await database(env, 'rpc/finish_calendar_sync', 'POST', {
      ...link, outcome: failure?.reauthorize ? 'reauthorize' : 'degraded', delay_seconds: Math.min(delay, 86_400),
    })
  }
}

export function scheduledSyncError() {
  // Timer failures can surface in Worker logs without exposing provider or database details.
  throw new Error('Calendar background sync could not finish')
}
