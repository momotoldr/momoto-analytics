/**
 * Minimal in-memory fixed-window rate limiter, keyed by client IP.
 *
 * Single-instance only (this service runs one). `sweep()` reclaims expired windows so the
 * map can't grow unbounded. Duplicated from momoto-realtime on purpose, plus
 * `retryAfterMs`, which the tracker honours on a 429.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record an attempt for `key`; returns true if it's within the window's budget. */
  allow(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count += 1
    return true
  }

  /** How long until `key`'s window resets (0 if it has none). */
  retryAfterMs(key: string, now: number = Date.now()): number {
    const entry = this.hits.get(key)
    return entry ? Math.max(0, entry.resetAt - now) : 0
  }

  /** Drop windows that have elapsed. Returns how many entries were reclaimed. */
  sweep(now: number = Date.now()): number {
    let removed = 0
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) {
        this.hits.delete(key)
        removed += 1
      }
    }
    return removed
  }
}
