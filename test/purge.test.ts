import { randomUUID } from 'node:crypto'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { prisma } from '../src/db/client.js'
import { claimDay, purge, runDailyPurge } from '../src/jobs/purge.js'
import { eventId, hasDatabase, resetDatabase } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-01T12:00:00Z')

/** One visit per day for `days` days, each with 3 events and a linked identity, all at
 *  mid-day so nothing sits exactly on the cutoff. */
async function seed(days: number) {
  for (let d = 0; d < days; d++) {
    const at = new Date(NOW.getTime() - (d + 0.5) * DAY)
    const sessionId = randomUUID()
    const anonId = randomUUID()
    await prisma.analyticsSession.create({
      data: { sessionId, anonId, startedAt: at, source: 'momoto-fe', context: {} },
    })
    await prisma.analyticsEvent.createMany({
      data: [0, 1, 2].map((i) => ({
        eventId: eventId(at.getTime() + i),
        sessionId,
        name: 'click',
        ts: new Date(at.getTime() + i),
        props: {},
      })),
    })
    await prisma.analyticsIdentity.create({ data: { anonId, userId: `u${d}`, lastSeenAt: at } })
  }
}

describe.skipIf(!hasDatabase)('retention purge (database)', () => {
  beforeEach(resetDatabase)
  afterAll(() => prisma.$disconnect())

  it('leaves exactly 90 days of events, visits and identities; a second run changes nothing', async () => {
    await seed(100)
    expect(await purge(90, NOW)).toEqual({ events: 30, sessions: 10, identities: 10 })
    expect(await prisma.analyticsEvent.count()).toBe(270)
    expect(await prisma.analyticsSession.count()).toBe(90)
    expect(await prisma.analyticsIdentity.count()).toBe(90)
    const oldest = await prisma.analyticsEvent.findFirstOrThrow({ orderBy: { ts: 'asc' } })
    expect(NOW.getTime() - oldest.ts.getTime()).toBeLessThan(90 * DAY)

    expect(await purge(90, NOW)).toEqual({ events: 0, sessions: 0, identities: 0 })
  })

  it('keeps an old visit whose events are still inside the window', async () => {
    const sessionId = randomUUID()
    const old = new Date(NOW.getTime() - 95 * DAY)
    await prisma.analyticsSession.create({
      data: { sessionId, anonId: randomUUID(), startedAt: old, source: 'x', context: {} },
    })
    await prisma.analyticsEvent.create({
      data: {
        eventId: eventId(),
        sessionId,
        name: 'click',
        ts: new Date(NOW.getTime() - DAY),
        props: {},
      },
    })
    await purge(90, NOW)
    expect(await prisma.analyticsSession.count()).toBe(1)
  })

  it('claims each day once, so two instances never both purge', async () => {
    expect(await claimDay('purge', NOW)).toBe(true)
    expect(await claimDay('purge', NOW)).toBe(false)
    expect(await runDailyPurge(90, NOW)).toBeNull()
    expect(await claimDay('purge', new Date(NOW.getTime() + DAY))).toBe(true)
  })
})
