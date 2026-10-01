import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { prisma } from '../src/db/client.js'
import { envelope, event, hasDatabase, post, resetDatabase, startServer } from './helpers.js'

// Its own file: the limiter is module state, and this test spends the whole budget.
describe.skipIf(!hasDatabase)('ingest rate limit (INGEST_RATE_LIMIT=60 in tests)', () => {
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    await resetDatabase()
    server = await startServer()
  })
  afterAll(async () => {
    await server.close()
    await prisma.$disconnect()
  })

  it('the 61st request in 10 minutes gets 429 with a Retry-After', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await post(`${server.url}/v1/b`, envelope([event('click')]))).status).toBe(202)
    }
    const res = await post(`${server.url}/v1/b`, envelope([event('click')]))
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(600)
  })
})
