import { isIP } from 'node:net'

import type { Request } from 'express'

import { logger } from './logger.js'

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
  const value = header ? req.get(header)?.split(',')[0]?.trim() : undefined
  const fromHeader = !!value && isIP(value) !== 0
  reportSource(req, header, fromHeader)
  return fromHeader ? value : req.ip
}

/** How many requests per process get the diagnostic line below. */
const REPORT_FIRST = 5
let reported = 0

/**
 * For the first few requests of each process: which address source was used, and which
 * proxy headers arrived — names, positions and booleans only, never an address. Behind a
 * CDN this is the one place a misconfigured header shows (the fallback is silent
 * otherwise), and the hop counts below are what other services' `TRUST_PROXY` relies on.
 */
function reportSource(req: Request, header: string | null, fromHeader: boolean): void {
  if (reported >= REPORT_FIRST) return
  reported += 1
  const forwarded = (req.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const visitor = header ? req.get(header)?.split(',')[0]?.trim() : undefined
  logger.info('client_ip.source', {
    configuredHeader: header,
    used: fromHeader ? 'header' : 'req.ip',
    present: ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for'].filter(
      (name) => req.get(name) !== undefined,
    ),
    forwardedForEntries: forwarded.length,
    // Where the visitor's address sits in X-Forwarded-For (-1: absent), and whether a
    // `trust proxy` hop count of 1 or 2 would have picked it — Express takes the entry
    // `hops` from the right. Positions and booleans only; no address is logged.
    visitorAt: visitor ? forwarded.indexOf(visitor) : -1,
    trust1PicksVisitor: !!visitor && forwarded[forwarded.length - 1] === visitor,
    trust2PicksVisitor: !!visitor && forwarded[forwarded.length - 2] === visitor,
  })
}
