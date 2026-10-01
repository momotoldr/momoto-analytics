import { EVENT_NAMES } from '../allowlist.js'

/**
 * Parsing and validation of one tracker batch — pure, no I/O, so every rule here is
 * unit-tested without a database.
 *
 * Two kinds of bad input, handled differently:
 * - **A bad envelope** (not an object, no events, malformed ids, over the cap) refuses
 *   the whole request with 400. The tracker never retries a 4xx.
 * - **A bad event** inside a good envelope (unknown name, malformed id, nested props) is
 *   dropped and counted, and the rest of the batch is kept — one stale event in an old
 *   tab must not sink twenty good ones.
 */

export type Scalar = string | number | boolean | null

export interface ParsedEvent {
  eventId: string
  name: string
  ts: Date
  type: 'PAGE' | 'COMPONENT' | null
  props: Record<string, Scalar>
}

export interface ParsedBatch {
  sessionId: string
  anonId: string
  source: string
  context: Record<string, unknown>
  /** Events the client evicted from a full queue (the envelope's own count). */
  dropped: number
  /** Events this server refused. */
  rejected: number
  /** Names that were refused for not being on the allowlist (for the log; capped). */
  unknownNames: string[]
  events: ParsedEvent[]
}

export type ParseResult = { ok: true; batch: ParsedBatch } | { ok: false; error: string }

export const MAX_EVENTS_PER_REQUEST = 100
/** Context is per visit and small (~220 B); anything near this is not a tracker. */
export const MAX_CONTEXT_BYTES = 4096
const MAX_PROPS = 50
const MAX_KEY_LENGTH = 64
const MAX_STRING_LENGTH = 1000
const MAX_SOURCE_LENGTH = 64
const DAY_MS = 24 * 60 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Scalars only, bounded — or `null` if any value is nested, so the event is refused. */
function parseProps(data: unknown): Record<string, Scalar> | null {
  if (data === undefined || data === null) return {}
  if (!isPlainObject(data)) return null
  const keys = Object.keys(data)
  if (keys.length > MAX_PROPS) return null
  const props: Record<string, Scalar> = {}
  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH) return null
    const value = data[key]
    if (value === null || typeof value === 'boolean') props[key] = value
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null
      props[key] = value
    } else if (typeof value === 'string') {
      props[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value
    } else return null
  }
  return props
}

/**
 * Client time → server time. The envelope's `sent_at` is the client's clock at send, so
 * `now − sent_at` is that clock's offset (plus transit, which is small). Then clamped to
 * within a day either side: a tab restored days later, or a wildly wrong clock, must not
 * write events into another month.
 */
export function correctTimestamp(timestamp: number, sentAt: unknown, now: number): Date {
  const skew = typeof sentAt === 'number' && Number.isFinite(sentAt) ? now - sentAt : 0
  const corrected = timestamp + skew
  return new Date(Math.min(now + DAY_MS, Math.max(now - DAY_MS, corrected)))
}

export function parseEnvelope(raw: unknown, now: number = Date.now()): ParseResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'invalid_body' }
  const { events, anon_id, session_id, source, context, sent_at, dropped } = raw

  if (!Array.isArray(events) || events.length === 0) return { ok: false, error: 'no_events' }
  if (events.length > MAX_EVENTS_PER_REQUEST) return { ok: false, error: 'too_many_events' }
  if (!isUuid(anon_id) || !isUuid(session_id)) return { ok: false, error: 'invalid_ids' }
  if (typeof source !== 'string' || !source || source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, error: 'invalid_source' }
  }

  let ctx: Record<string, unknown> = isPlainObject(context) ? context : {}
  if (Buffer.byteLength(JSON.stringify(ctx)) > MAX_CONTEXT_BYTES) ctx = { oversized: true }

  const batch: ParsedBatch = {
    sessionId: session_id.toLowerCase(),
    anonId: anon_id.toLowerCase(),
    source,
    context: ctx,
    dropped:
      typeof dropped === 'number' && Number.isInteger(dropped) && dropped > 0
        ? Math.min(dropped, 1_000_000)
        : 0,
    rejected: 0,
    unknownNames: [],
    events: [],
  }

  for (const item of events) {
    const parsed = isPlainObject(item) ? parseEvent(item, sent_at, now) : null
    if (parsed === 'unknown') {
      batch.rejected += 1
      const name = String((item as Record<string, unknown>).event_name).slice(0, 40)
      if (batch.unknownNames.length < 5 && !batch.unknownNames.includes(name)) {
        batch.unknownNames.push(name)
      }
    } else if (parsed === null) {
      batch.rejected += 1
    } else {
      batch.events.push(parsed)
    }
  }
  return { ok: true, batch }
}

function parseEvent(
  item: Record<string, unknown>,
  sentAt: unknown,
  now: number,
): ParsedEvent | 'unknown' | null {
  const { event_id, event_name, event_type, timestamp, data } = item
  if (!isUuid(event_id)) return null
  if (typeof event_name !== 'string' || !EVENT_NAMES.has(event_name)) return 'unknown'
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  const props = parseProps(data)
  if (props === null) return null
  return {
    eventId: event_id.toLowerCase(),
    name: event_name,
    ts: correctTimestamp(timestamp, sentAt, now),
    type: event_type === 'PAGE' || event_type === 'COMPONENT' ? event_type : null,
    props,
  }
}
