import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../src/db/client.js'
import {
  envelope,
  event,
  hasDatabase,
  ORIGIN,
  post,
  resetDatabase,
  startServer,
  token,
} from './helpers.js'

describe.skipIf(!hasDatabase)('ingest + identify (database)', () => {
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    server = await startServer()
  })
  afterAll(async () => {
    await server.close()
    await prisma.$disconnect()
  })
  beforeEach(resetDatabase)

  describe('POST /v1/b', () => {
    it('stores a batch: one visit row, its events, 202', async () => {
      const body = envelope([event('page_view', { route: '/' }), event('click', { id: 'x' })])
      const res = await post(`${server.url}/v1/b`, body)
      expect(res.status).toBe(202)
      expect(await res.json()).toMatchObject({ status: 'success' })
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)

      const session = await prisma.analyticsSession.findUniqueOrThrow({
        where: { sessionId: body.session_id },
      })
      expect(session).toMatchObject({ anonId: body.anon_id, source: 'momoto-fe', dropped: 0 })
      expect(session.ipPrefix).toBe('127.0.0.0/24')
      const events = await prisma.analyticsEvent.findMany({
        where: { sessionId: body.session_id },
        orderBy: { ts: 'asc' },
      })
      expect(events.map((e) => e.name)).toEqual(['page_view', 'click'])
    })

    it('replaying the same batch stores its events once', async () => {
      const body = envelope([event('shot_taken', { index: 0 }), event('shot_taken', { index: 1 })])
      for (let i = 0; i < 3; i++) expect((await post(`${server.url}/v1/b`, body)).status).toBe(202)
      expect(await prisma.analyticsEvent.count()).toBe(2)
      expect(await prisma.analyticsSession.count()).toBe(1)
    })

    it('keeps the good events when one has an unknown name, and counts the reject', async () => {
      const body = envelope([event('click'), event('made_up_event'), event('page_view')], {
        dropped: 4,
      })
      expect((await post(`${server.url}/v1/b`, body)).status).toBe(202)
      expect(await prisma.analyticsEvent.count()).toBe(2)
      const session = await prisma.analyticsSession.findUniqueOrThrow({
        where: { sessionId: body.session_id },
      })
      expect(session).toMatchObject({ rejected: 1, dropped: 4 })
    })

    it('a later batch of the same visit adds up and can move its start earlier', async () => {
      const ids = { session_id: randomUUID(), anon_id: randomUUID() }
      const now = Date.now()
      await post(`${server.url}/v1/b`, envelope([event('click', {}, now)], { ...ids, dropped: 1 }))
      await post(
        `${server.url}/v1/b`,
        envelope([event('click', {}, now - 60_000)], { ...ids, dropped: 2 }),
      )
      const session = await prisma.analyticsSession.findUniqueOrThrow({
        where: { sessionId: ids.session_id },
      })
      expect(session.dropped).toBe(3)
      expect(session.startedAt.getTime()).toBe(now - 60_000)
    })

    it('POST /v1/e takes the same envelope', async () => {
      const res = await post(`${server.url}/v1/e`, envelope([event('payment_succeeded')]))
      expect(res.status).toBe(202)
      expect(await prisma.analyticsEvent.count()).toBe(1)
    })

    it('refuses 101 events, bad JSON and other origins', async () => {
      const many = envelope(Array.from({ length: 101 }, () => event('click')))
      expect((await post(`${server.url}/v1/b`, many)).status).toBe(400)
      expect((await post(`${server.url}/v1/b`, '{not json')).status).toBe(400)
      const foreign = await post(`${server.url}/v1/b`, envelope([event('click')]), {
        Origin: 'https://evil.example',
      })
      expect(foreign.status).toBe(403)
      expect(await prisma.analyticsEvent.count()).toBe(0)
    })

    it('answers 503 when the database fails, so the tracker keeps the batch', async () => {
      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('connection refused'))
      const res = await post(`${server.url}/v1/b`, envelope([event('click')]))
      expect(res.status).toBe(503)
    })
  })

  describe('/v1/b/identify', () => {
    const identify = (anonId: unknown, auth?: string) =>
      fetch(`${server.url}/v1/b/identify`, {
        method: 'POST',
        body: JSON.stringify({ anonId }),
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          ...(auth ? { Authorization: auth } : {}),
        },
      })

    it('links browsers to the signed-in user, and DELETE unlinks them all', async () => {
      const a = randomUUID()
      const b = randomUUID()
      expect((await identify(a, `Bearer ${token('user-1')}`)).status).toBe(204)
      expect((await identify(b, `Bearer ${token('user-1')}`)).status).toBe(204)
      expect((await identify(a, `Bearer ${token('user-1')}`)).status).toBe(204) // idempotent
      await identify(randomUUID(), `Bearer ${token('user-2')}`)
      expect(await prisma.analyticsIdentity.count({ where: { userId: 'user-1' } })).toBe(2)

      const res = await fetch(`${server.url}/v1/b/identify`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Authorization: `Bearer ${token('user-1')}` },
      })
      expect(res.status).toBe(204)
      expect(await prisma.analyticsIdentity.count({ where: { userId: 'user-1' } })).toBe(0)
      expect(await prisma.analyticsIdentity.count({ where: { userId: 'user-2' } })).toBe(1)
    })

    it('refuses a missing or wrongly signed token, and a malformed anonId', async () => {
      expect((await identify(randomUUID())).status).toBe(401)
      expect(
        (await identify(randomUUID(), `Bearer ${token('u', 'some-other-secret')}`)).status,
      ).toBe(401)
      expect((await identify('nope', `Bearer ${token('user-1')}`)).status).toBe(400)
      expect(await prisma.analyticsIdentity.count()).toBe(0)
    })

    it('allows the Authorization header in a preflight from the frontend', async () => {
      const res = await fetch(`${server.url}/v1/b/identify`, {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
      expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
        'authorization',
      )
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    })
  })

  it('GET /healthz reports the database', async () => {
    const res = await fetch(`${server.url}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', db: 'up' })
  })
})
