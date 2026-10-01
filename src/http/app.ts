import cors from 'cors'
import express, { type Express, type RequestHandler } from 'express'
import helmet from 'helmet'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { isDraining } from '../lifecycle.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { identifyRouter } from './routes/identify.js'
import { ingestRouter } from './routes/ingest.js'

const DB_CHECK_TIMEOUT_MS = 1000

/** `SELECT 1`, bounded — a hung database must not hang the health check. */
async function databaseStatus(): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS)
      }),
    ])
    return 'up'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Requests that carry an `Origin` must come from the frontend. A beacon from any other
 * site is simple enough that CORS alone would not stop it from landing — CORS only stops
 * the sender reading the answer — so it is refused here. Requests with no `Origin` (curl,
 * server-to-server) pass: this is hygiene against other sites, not authentication, which
 * the allowlist and the rate limit cover.
 */
const originGuard: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin
  if (origin && !env.corsOrigins.includes(origin)) {
    res.status(403).json({ error: 'origin_not_allowed' })
    return
  }
  next()
}

/**
 * The analytics surface: two ingest paths, identify, and health. Nothing here is on any
 * user's critical path — the tracker is lossy-with-retry and the product never waits on
 * this service.
 */
export function createApp(): Express {
  const app = express()

  // Railway's proxy puts the client in X-Forwarded-For. Without this `req.ip` is the
  // proxy for everyone, and per-IP limits would throttle all users as one. Behind
  // Cloudflare that is still not enough — see `CLIENT_IP_HEADER` / `lib/clientIp.ts`.
  app.set('trust proxy', env.trustProxy)

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  )

  /**
   * Readiness: 503 only while draining. A database outage does **not** fail it — the
   * platform would restart a healthy process over a DB blip, while ingest's 503s already
   * make the tracker hold its events until the database is back. `db` says which it is.
   */
  app.get('/healthz', (_req, res, next) => {
    if (isDraining()) {
      res.status(503).json({ status: 'draining', uptime: process.uptime() })
      return
    }
    databaseStatus()
      .then((db) => res.json({ status: 'ok', uptime: process.uptime(), db }))
      .catch(next)
  })

  // No credentials: the tracker never sends cookies, and identify uses a bearer token.
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: false,
      methods: ['POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  )
  app.use(originGuard)

  // Before the ingest router, whose `/b` would otherwise be tried first — it doesn't match
  // `/b/identify`, but the order makes the routing obvious.
  app.use('/v1/b/identify', identifyRouter)
  app.use('/v1', ingestRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
