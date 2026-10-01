import jwt from 'jsonwebtoken'

import { env } from '../config/env.js'

/**
 * Verification only. Access tokens are minted by `momoto-core` (`auth/tokens.ts`), which
 * also owns refresh rotation and revocation against Postgres. This service only checks
 * the signature on `/v1/b/identify`, so it needs the shared `JWT_SECRET` and nothing else.
 * Copied from momoto-realtime on purpose (no shared package between services).
 */

/** Verified access-token claims we rely on. */
export interface AccessClaims {
  /** User id. */
  sub: string
}

/** Verifies an access JWT, returning its claims. Throws if invalid/expired. */
export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.jwtSecret)
  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('malformed access token')
  }
  return { sub: payload.sub }
}
