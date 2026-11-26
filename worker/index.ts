interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/health' && request.method === 'GET') {
      return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } })
    }
    if (pathname.startsWith('/api/')) return new Response(null, { status: 404 })
    return env.ASSETS.fetch(request)
  },
}
