import { isIP } from 'node:net'

import type { Request } from 'express'

/**
 * The visitor's address — for the per-IP rate limits and the stored `/24` prefix.
 *
 * Behind Cloudflare, `req.ip` is the wrong answer. Requests go visitor → Cloudflare →
 * Railway's edge → this process, and Express's `trust proxy` hop count stops at Railway's
 * edge: measured on staging (2026-10-01), every request appeared to come from the edge's own
 * address (CDN77 Singapore), so all visitors in a region shared one rate-limit bucket.
 *
 * Cloudflare puts the visitor's address in `CF-Connecting-IP` on every request it forwards,
 * so with `CLIENT_IP_HEADER=cf-connecting-ip` that header wins. It is only as trustworthy
 * as the route in: someone reaching the service *without* passing Cloudflare (a
 * `*.up.railway.app` domain) could set it to anything — which only lets them dodge a rate
 * limit, so keep this service on the Cloudflare domain alone. A missing or malformed header
 * falls back to `req.ip`.
 */
export function clientIp(req: Request, header: string | null): string | undefined {
  if (header) {
    const value = req.get(header)?.split(',')[0]?.trim()
    if (value && isIP(value)) return value
  }
  return req.ip
}
