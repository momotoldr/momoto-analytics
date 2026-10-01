import express, { Router, type RequestHandler } from 'express'

import { verifyAccessToken } from '../../auth/verifyAccessToken.js'
import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { clientIp } from '../../lib/clientIp.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { asyncRoute } from '../asyncRoute.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BEARER = 'Bearer '

const limiter = new RateLimiter(env.identifyRateLimit, 10 * 60_000)

export function sweepIdentifyLimits(now: number = Date.now()): number {
  return limiter.sweep(now)
}

const rateLimit: RequestHandler = (req, res, next) => {
  const key = clientIp(req, env.clientIpHeader) ?? 'unknown'
  if (limiter.allow(key)) return next()
  res.set('Retry-After', String(Math.ceil(limiter.retryAfterMs(key) / 1000)))
  res.status(429).json({ error: 'too_many_requests' })
}

/**
 * The signed-in user, from momoto-core's access token. The user id comes only from here —
 * never from an event body, which anyone can write.
 *
 * Failures are logged: a `JWT_SECRET` that differs from core's fails nowhere else, it just
 * makes every identify a 401 — and the frontend ignores that, so this line is the only
 * place it shows.
 */
const requireUser: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization
  if (!header?.startsWith(BEARER)) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  try {
    res.locals.userId = verifyAccessToken(header.slice(BEARER.length).trim()).sub
    next()
  } catch (err) {
    logger.warn('identify.unauthorized', {
      reason: err instanceof Error ? err.name : 'unknown',
    })
    res.status(401).json({ error: 'unauthorized' })
  }
}

export const identifyRouter = Router()

/**
 * `POST /v1/b/identify { anonId }` — this browser belongs to this account. Called on sign-in
 * and on session restore. A signed-in user can only link a browser to *their own* account,
 * and an anonId is a random v4 UUID nobody else can guess.
 */
identifyRouter.post(
  '/',
  rateLimit,
  express.json({ type: ['application/json', 'text/plain'], limit: '1kb' }),
  requireUser,
  asyncRoute(async (req, res) => {
    const anonId = (req.body as { anonId?: unknown } | undefined)?.anonId
    if (typeof anonId !== 'string' || !UUID.test(anonId)) {
      res.status(400).json({ error: 'invalid_anon_id' })
      return
    }
    const userId = res.locals.userId as string
    const now = new Date()
    await prisma.analyticsIdentity.upsert({
      where: { anonId: anonId.toLowerCase() },
      create: { anonId: anonId.toLowerCase(), userId, lastSeenAt: now },
      update: { userId, lastSeenAt: now },
    })
    res.status(204).end()
  }),
)

/**
 * `DELETE /v1/b/identify` — unlink every browser from the signed-in account. The frontend
 * calls it just before deleting the account, while its token still works. Best-effort by
 * design: links also expire with the retention window, so a missed call only delays it.
 */
identifyRouter.delete(
  '/',
  rateLimit,
  requireUser,
  asyncRoute(async (_req, res) => {
    await prisma.analyticsIdentity.deleteMany({ where: { userId: res.locals.userId as string } })
    res.status(204).end()
  }),
)
