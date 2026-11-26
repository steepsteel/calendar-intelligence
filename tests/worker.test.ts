import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../worker/index.ts'

const env = { ASSETS: { fetch: async () => new Response('dashboard') } }

test('Worker serves health, dispatches dashboard assets and rejects unknown API routes', async () => {
  const health = await worker.fetch(new Request('https://example.test/api/health'), env)
  assert.deepEqual(await health.json(), { status: 'ok' })
  assert.equal(health.headers.get('cache-control'), 'no-store')
  const unknown = await worker.fetch(new Request('https://example.test/api/missing'), env)
  assert.equal(unknown.status, 404)
  const dashboard = await worker.fetch(new Request('https://example.test/'), env)
  assert.equal(await dashboard.text(), 'dashboard')
})
