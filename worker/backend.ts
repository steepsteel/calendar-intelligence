export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  APP_ORIGIN?: string
  WATCH_PROBE_ENABLED?: string
  OWNER_USER_ID?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  CALENDAR_TOKEN_KEY?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  MICROSOFT_CLIENT_ID?: string
  MICROSOFT_CLIENT_SECRET?: string
  ZOHO_CLIENT_ID?: string
  ZOHO_CLIENT_SECRET?: string
  ZOHO_REGION?: string
}

export const privateHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: privateHeaders })
}

export function configured(env: Env) {
  return Boolean(env.APP_ORIGIN && env.OWNER_USER_ID && env.SUPABASE_URL &&
    env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY && env.CALENDAR_TOKEN_KEY)
}

export async function database<T>(env: Env, path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await fetch(new URL('/rest/v1/' + path, env.SUPABASE_URL), {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
      ...(env.SUPABASE_SERVICE_ROLE_KEY?.startsWith('eyJ')
        ? { authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
        : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!result.ok) throw new Error('Calendar database request failed')
  const data = await result.text()
  return data ? JSON.parse(data) as T : undefined as T
}

export async function isOwner(request: Request, env: Env) {
  const token = request.headers.get('authorization')
  if (!token?.startsWith('Bearer ')) return false
  const result = await fetch(new URL('/auth/v1/user', env.SUPABASE_URL), {
    headers: { apikey: env.SUPABASE_ANON_KEY!, authorization: token },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  return result.ok && (await result.json()).id === env.OWNER_USER_ID
}

const utf8 = new TextEncoder()

export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decode(value: string) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), value => value.charCodeAt(0))
}

export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function digest(value: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value))))
}

async function tokenKey(encodedKey: string) {
  const raw = decode(encodedKey)
  if (raw.byteLength !== 32) throw new Error('Invalid calendar encryption key')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function sealToken(key: string, context: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(context) },
    await tokenKey(key), utf8.encode(token),
  )
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(cipher))}`
}

export async function openToken(key: string, context: string, sealed: string) {
  const [version, iv, cipher] = sealed.split('.')
  if (version !== 'v1') throw new Error('Unknown calendar credential version')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv), additionalData: utf8.encode(context) },
    await tokenKey(key), decode(cipher),
  )
  return new TextDecoder().decode(plain)
}

export function tokenContext(userId: string, provider: string, accountId: string) {
  return JSON.stringify([userId, provider, accountId])
}
