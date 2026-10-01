// Side-effect import: reads .env.local + .env into process.env. Must stay above every
// other import here, and `src/index.ts` imports it first of all for the same reason.
import './loadEnv.js'

import { logger } from '../lib/logger.js'

export interface Env {
  port: number
  /** Frontend origins allowed to send events. Any other `Origin` is refused (403). */
  corsOrigins: string[]
  /** How many reverse-proxy hops sit in front of us (Express `trust proxy`). */
  trustProxy: number
  /**
   * A header carrying the visitor's address, set by the CDN in front of us — on Railway
   * behind Cloudflare, `cf-connecting-ip`. Wins over `req.ip`, which there resolves to
   * Railway's edge rather than the visitor. See `lib/clientIp.ts`.
   */
  clientIpHeader: string | null
  /**
   * Verifies the access tokens `momoto-core` signs, for `/v1/b/identify`. Must be
   * **identical** to core's: a mismatch doesn't fail at boot, identify just answers 401.
   */
  jwtSecret: string
  /** Events, visits and identity links older than this are deleted daily. */
  retentionDays: number
  /**
   * Ingest requests per IP per 10 minutes. Generous on purpose: mobile carriers put many
   * phones behind one address (CGNAT), and one busy visit alone can send a batch every
   * 10 s. This is a spam brake, not a quota.
   */
  ingestRateLimit: number
  /** Identify calls per IP per 10 minutes (once per sign-in / page load). */
  identifyRateLimit: number
}

const DEFAULT_DEV_ORIGIN = 'http://localhost:5173'

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseOrigins(raw: string | undefined): string[] {
  const origins = parseCsv(raw)
  if (origins.length === 0) {
    logger.warn('config.cors.default', {
      msg: 'CORS_ORIGINS not set; defaulting to the dev origin. Set it in production.',
      origin: DEFAULT_DEV_ORIGIN,
    })
    return [DEFAULT_DEV_ORIGIN]
  }
  return origins
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a positive integer)`)
  }
  return n
}

function nonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a non-negative integer)`)
  }
  return n
}

/** Require a non-empty secret from the environment (never hardcode secrets). */
function requiredSecret(name: string, raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) {
    throw new Error(`Missing ${name}: set it in the environment (see .env.example).`)
  }
  return value
}

export const env: Env = {
  port: positiveInt('PORT', process.env.PORT, 3004),
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  trustProxy: nonNegativeInt('TRUST_PROXY', process.env.TRUST_PROXY, 0),
  clientIpHeader: process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || null,
  jwtSecret: requiredSecret('JWT_SECRET', process.env.JWT_SECRET),
  retentionDays: positiveInt('RETENTION_DAYS', process.env.RETENTION_DAYS, 90),
  ingestRateLimit: positiveInt('INGEST_RATE_LIMIT', process.env.INGEST_RATE_LIMIT, 600),
  identifyRateLimit: positiveInt('IDENTIFY_RATE_LIMIT', process.env.IDENTIFY_RATE_LIMIT, 60),
}
