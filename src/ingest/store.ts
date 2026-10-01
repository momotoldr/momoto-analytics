import { prisma } from '../db/client.js'
import type { ParsedBatch } from './envelope.js'

/**
 * Writes one batch in one transaction: the visit row, then its events.
 *
 * **Idempotent on `event_id`.** The tracker delivers at-least-once — retries, the reload
 * backup and the close-time beacon all resend — and `skipDuplicates` turns every repeat
 * into a no-op. (The visit's `dropped` / `rejected` counters are not deduplicated: a
 * replayed batch counts its rejects twice. They are rough diagnostics, not data.)
 *
 * @returns how many events were new.
 */
export async function storeBatch(batch: ParsedBatch, ipPrefix: string | null): Promise<number> {
  const startedAt = batch.events.length
    ? new Date(Math.min(...batch.events.map((e) => e.ts.getTime())))
    : new Date()

  const [, inserted] = await prisma.$transaction([
    // The first batch of a visit creates its row; later ones only move `started_at`
    // earlier (batches can arrive out of order) and add to the counters. Context is the
    // first batch's: it describes the visit, and is constant within one.
    prisma.$executeRaw`
      INSERT INTO analytics_session
        (session_id, anon_id, started_at, source, context, ip_prefix, dropped, rejected)
      VALUES
        (${batch.sessionId}::uuid, ${batch.anonId}::uuid, ${startedAt}, ${batch.source},
         ${JSON.stringify(batch.context)}::jsonb, ${ipPrefix}, ${batch.dropped}, ${batch.rejected})
      ON CONFLICT (session_id) DO UPDATE SET
        started_at = LEAST(analytics_session.started_at, EXCLUDED.started_at),
        dropped    = analytics_session.dropped + EXCLUDED.dropped,
        rejected   = analytics_session.rejected + EXCLUDED.rejected`,
    prisma.analyticsEvent.createMany({
      data: batch.events.map((e) => ({
        eventId: e.eventId,
        sessionId: batch.sessionId,
        name: e.name,
        ts: e.ts,
        type: e.type,
        props: e.props,
      })),
      skipDuplicates: true,
    }),
  ])
  return inserted.count
}
