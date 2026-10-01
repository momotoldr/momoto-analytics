// FIRST, before any other import: populates process.env from .env.local + .env. See
// src/config/loadEnv.ts.
import './config/loadEnv.js'

import { createServer } from 'node:http'

import { env } from './config/env.js'
import { prisma } from './db/client.js'
import { createApp } from './http/app.js'
import { sweepIdentifyLimits } from './http/routes/identify.js'
import { sweepIngestLimits } from './http/routes/ingest.js'
import { startPurgeJob } from './jobs/purge.js'
import { beginDraining } from './lifecycle.js'
import { logger } from './lib/logger.js'

/** Backstop: stop waiting on a shutdown that isn't finishing and go. */
const SHUTDOWN_HARD_STOP_MS = 10_000

const httpServer = createServer(createApp())
const stopPurgeJob = startPurgeJob(env.retentionDays)

// Reclaim elapsed rate-limit windows so the maps can't grow unbounded. `unref` so the
// timer never blocks shutdown; contained, because a throw in a timer ends the process.
const sweeper = setInterval(() => {
  try {
    sweepIngestLimits()
    sweepIdentifyLimits()
  } catch (err) {
    logger.error('sweep.failed', { err: String(err) })
  }
}, 60_000)
sweeper.unref()

httpServer.listen(env.port, () => {
  logger.info('server.listening', {
    port: env.port,
    corsOrigins: env.corsOrigins,
    retentionDays: env.retentionDays,
  })
})

let shuttingDown = false

/**
 * Stop being routed to, finish the requests in flight (each is one short transaction),
 * close the database pool, exit 0. Railway sends SIGTERM to `node` directly — this is PID
 * 1, not npm, which would swallow the signal.
 */
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  beginDraining()
  logger.info('server.shutdown', { signal })
  clearInterval(sweeper)
  stopPurgeJob()

  httpServer.close(() => {
    prisma
      .$disconnect()
      .catch(() => {})
      .finally(() => process.exit(0))
  })
  httpServer.closeIdleConnections()
  setTimeout(() => process.exit(1), SHUTDOWN_HARD_STOP_MS).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Log and keep serving on a stray rejection; restart (via the platform) on an uncaught
// exception, where the process may be in an undefined state.
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', {
    err: reason instanceof Error ? reason.message : String(reason),
  })
})
process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { err: err.message, stack: err.stack })
  shutdown('uncaughtException')
})
