import { prisma } from '../db/client.js'
import { logger } from '../lib/logger.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Rows per DELETE, so one purge never holds a long lock or one giant transaction. */
const BATCH = 10_000

export interface PurgeResult {
  events: number
  sessions: number
  identities: number
}

/**
 * Deletes everything older than `retentionDays`: events by their time, visits once none
 * of their events remain, and identity links not seen since the cutoff.
 *
 * Identity links expire on the same clock as the events they point at. That is the
 * privacy backstop for account deletion: whatever the frontend's unlink call missed, no
 * account stays linked to its clickstream longer than the clickstream itself exists.
 */
export async function purge(retentionDays: number, now: Date = new Date()): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS)
  const result: PurgeResult = { events: 0, sessions: 0, identities: 0 }

  for (;;) {
    const n = await prisma.$executeRaw`
      DELETE FROM analytics_event WHERE event_id IN (
        SELECT event_id FROM analytics_event WHERE ts < ${cutoff} LIMIT ${BATCH})`
    result.events += n
    if (n < BATCH) break
  }

  for (;;) {
    const n = await prisma.$executeRaw`
      DELETE FROM analytics_session WHERE session_id IN (
        SELECT s.session_id FROM analytics_session s
        WHERE s.started_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM analytics_event e WHERE e.session_id = s.session_id)
        LIMIT ${BATCH})`
    result.sessions += n
    if (n < BATCH) break
  }

  result.identities = await prisma.$executeRaw`
    DELETE FROM analytics_identity WHERE last_seen_at < ${cutoff}`

  return result
}

/**
 * Claims today for `job`. A conditional UPDATE is atomic, so when Railway briefly runs two
 * instances during a deploy, exactly one of them gets `true`.
 */
export async function claimDay(job: string, now: Date = new Date()): Promise<boolean> {
  const today = now.toISOString().slice(0, 10)
  const claimed = await prisma.$executeRaw`
    UPDATE analytics_job SET last_run_on = ${today}::date
    WHERE name = ${job} AND last_run_on < ${today}::date`
  return claimed === 1
}

/** The once-a-day purge, if this instance wins today's claim. */
export async function runDailyPurge(
  retentionDays: number,
  now: Date = new Date(),
): Promise<PurgeResult | null> {
  if (!(await claimDay('purge', now))) return null
  const result = await purge(retentionDays, now)
  logger.info('purge.done', { retentionDays, ...result })
  return result
}

/**
 * Checks hourly (and once a minute after boot) whether today's purge has run. The timers
 * are `unref`'d so they never hold the process open, and every failure is contained: a
 * throw in a timer has no caller to catch it and would end the process.
 */
export function startPurgeJob(retentionDays: number): () => void {
  const tick = () => {
    runDailyPurge(retentionDays).catch((err: unknown) => {
      logger.error('purge.failed', { err: err instanceof Error ? err.message : String(err) })
    })
  }
  const first = setTimeout(tick, 60_000)
  const hourly = setInterval(tick, 60 * 60_000)
  first.unref()
  hourly.unref()
  return () => {
    clearTimeout(first)
    clearInterval(hourly)
  }
}
