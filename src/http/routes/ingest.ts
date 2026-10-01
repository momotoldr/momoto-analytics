import { randomUUID } from 'node:crypto'

import express, { Router } from 'express'

import { env } from '../../config/env.js'
import { parseEnvelope } from '../../ingest/envelope.js'
import { storeBatch } from '../../ingest/store.js'
import { ipPrefix } from '../../lib/ipPrefix.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { asyncRoute } from '../asyncRoute.js'

const WINDOW_MS = 10 * 60_000

/** One limiter for both ingest paths: they are one budget from one page. */
const limiter = new RateLimiter(env.ingestRateLimit, WINDOW_MS)

/** Reclaim expired windows (wired into the sweeper in `index.ts`). */
export function sweepIngestLimits(now: number = Date.now()): number {
  return limiter.sweep(now)
}

export const ingestRouter = Router()

/**
 * The tracker sends `text/plain` on every path — a beacon can't send anything else, and
 * plain text keeps the request CORS-simple (no preflight). JSON is accepted too, for curl
 * and tests. The tracker keeps unload bodies under 60 KB.
 */
const body = express.text({ type: ['text/plain', 'application/json'], limit: '64kb' })

/**
 * `POST /v1/b` (batch) and `POST /v1/e` (one real-time event) — the same envelope, the
 * same handler. Always `202` on success; the tracker never reads the body.
 */
ingestRouter.post(
  ['/b', '/e'],
  body,
  asyncRoute(async (req, res) => {
    const key = req.ip ?? 'unknown'
    if (!limiter.allow(key)) {
      // The tracker honours Retry-After, so a throttled page backs off instead of hammering.
      res.set('Retry-After', String(Math.ceil(limiter.retryAfterMs(key) / 1000)))
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(typeof req.body === 'string' ? req.body : '')
    } catch {
      res.status(400).json({ error: 'invalid_json' })
      return
    }

    const parsed = parseEnvelope(raw)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }
    const { batch } = parsed

    try {
      await storeBatch(batch, ipPrefix(req.ip))
    } catch (err) {
      // Not the client's fault and not permanent: 503 makes the tracker retry, then keep
      // the batch for later. The product itself never notices.
      logger.error('ingest.db_failed', { err: err instanceof Error ? err.message : String(err) })
      res.status(503).json({ error: 'unavailable' })
      return
    }

    if (batch.rejected > 0) {
      // Usually an event the frontend added without adding it to `allowlist.ts`.
      logger.warn('ingest.rejected', { count: batch.rejected, unknownNames: batch.unknownNames })
    }
    res.status(202).json({ status: 'success', request_id: randomUUID(), timestamp: Date.now() })
  }),
)
