import { describe, expect, it } from 'vitest'

import { correctTimestamp, MAX_EVENTS_PER_REQUEST, parseEnvelope } from '../src/ingest/envelope.js'
import { ipPrefix } from '../src/lib/ipPrefix.js'
import { envelope, event } from './helpers.js'

const NOW = 1_790_000_000_000
const DAY = 24 * 60 * 60 * 1000

describe('parseEnvelope', () => {
  it('accepts a tracker batch and normalises it', () => {
    const body = envelope([event('shot_taken', { index: 2, mode: 'date' }, NOW)], { sent_at: NOW })
    const result = parseEnvelope(body, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.batch).toMatchObject({
      source: 'momoto-fe',
      rejected: 0,
      events: [{ name: 'shot_taken', props: { index: 2, mode: 'date' }, type: null }],
    })
    expect(result.batch.events[0]!.ts.getTime()).toBe(NOW)
  })

  it.each([
    ['not an object', [1, 2], 'invalid_body'],
    ['no events', envelope([]), 'no_events'],
    [
      'over the cap',
      envelope(Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => event('click'))),
      'too_many_events',
    ],
    ['bad session id', envelope([event('click')], { session_id: 'nope' }), 'invalid_ids'],
    ['no source', envelope([event('click')], { source: '' }), 'invalid_source'],
  ])('refuses the whole request: %s', (_, body, error) => {
    expect(parseEnvelope(body, NOW)).toEqual({ ok: false, error })
  })

  it('drops and counts bad events but keeps the rest', () => {
    const body = envelope([
      event('shot_taken', { index: 0 }),
      event('not_on_the_list'),
      event('click', { nested: { a: 1 } }),
      { ...event('click'), event_id: 'not-a-uuid' },
      event('click', { id: null, el: 'button', route: '/' }),
    ])
    const result = parseEnvelope(body, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.batch.events.map((e) => e.name)).toEqual(['shot_taken', 'click'])
    expect(result.batch.rejected).toBe(3)
    expect(result.batch.unknownNames).toEqual(['not_on_the_list'])
  })

  it('bounds what it stores', () => {
    const body = envelope([event('click', { long: 'x'.repeat(5000) })], {
      context: { blob: 'y'.repeat(10_000) },
      dropped: 1e9,
    })
    const result = parseEnvelope(body, NOW)
    if (!result.ok) throw new Error('expected ok')
    expect((result.batch.events[0]!.props.long as string).length).toBe(1000)
    expect(result.batch.context).toEqual({ oversized: true })
    expect(result.batch.dropped).toBe(1_000_000)
  })

  it('lower-cases ids so one visit is one row whatever the client sent', () => {
    const body = envelope([event('click')], { session_id: 'ABCDEF01-2345-4789-8ABC-DEF012345678' })
    const result = parseEnvelope(body, NOW)
    if (!result.ok) throw new Error('expected ok')
    expect(result.batch.sessionId).toBe('abcdef01-2345-4789-8abc-def012345678')
  })
})

describe('correctTimestamp', () => {
  it('shifts client time by the client clock’s offset', () => {
    // Client clock 5 minutes fast: sent_at reads NOW + 5 min.
    expect(correctTimestamp(NOW + 5 * 60_000 - 1000, NOW + 5 * 60_000, NOW).getTime()).toBe(
      NOW - 1000,
    )
  })

  it('clamps to a day either side', () => {
    expect(correctTimestamp(NOW - 10 * DAY, NOW, NOW).getTime()).toBe(NOW - DAY)
    expect(correctTimestamp(NOW + 10 * DAY, NOW, NOW).getTime()).toBe(NOW + DAY)
  })

  it('without sent_at, takes the client time as is', () => {
    expect(correctTimestamp(NOW - 5000, undefined, NOW).getTime()).toBe(NOW - 5000)
  })
})

describe('ipPrefix', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['::ffff:198.51.100.9', '198.51.100.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    [undefined, null],
    ['not-an-ip', null],
  ])('%s → %s', (ip, expected) => {
    expect(ipPrefix(ip)).toBe(expected)
  })
})
