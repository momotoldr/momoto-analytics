import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { clientIp, rateLimitKey } from '../src/lib/clientIp.js'

function request(headers: Record<string, string>, ip = '152.233.15.10'): Request {
  return { ip, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request
}

describe('clientIp', () => {
  it('uses the configured header when it holds an address', () => {
    expect(clientIp(request({ 'cf-connecting-ip': '111.68.121.7' }), 'cf-connecting-ip')).toBe(
      '111.68.121.7',
    )
    expect(clientIp(request({ 'cf-connecting-ip': '2001:db8::1' }), 'cf-connecting-ip')).toBe(
      '2001:db8::1',
    )
  })

  it('falls back to req.ip when the header is absent, malformed, or not configured', () => {
    expect(clientIp(request({}), 'cf-connecting-ip')).toBe('152.233.15.10')
    expect(clientIp(request({ 'cf-connecting-ip': 'nonsense' }), 'cf-connecting-ip')).toBe(
      '152.233.15.10',
    )
    expect(clientIp(request({ 'cf-connecting-ip': '111.68.121.7' }), null)).toBe('152.233.15.10')
  })
})

describe('rateLimitKey', () => {
  it('keeps an IPv4 address whole, including one seen as IPv4-mapped IPv6', () => {
    expect(rateLimitKey('111.68.121.7')).toBe('111.68.121.7')
    expect(rateLimitKey('::ffff:111.68.121.7')).toBe('111.68.121.7')
  })

  it('folds every address in one IPv6 /64 into one bucket', () => {
    const key = rateLimitKey('2001:db8:5:6::1')
    expect(key).toBe('2001:db8:5:6::/64')
    expect(rateLimitKey('2001:db8:5:6:ffff:ffff:ffff:ffff')).toBe(key)
    expect(rateLimitKey('2001:0db8:0005:0006:abcd::9')).toBe(key)
  })

  it('keeps different /64s apart', () => {
    expect(rateLimitKey('2001:db8:5:7::1')).not.toBe(rateLimitKey('2001:db8:5:6::1'))
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  it('shares one bucket when there is no address', () => {
    expect(rateLimitKey(undefined)).toBe('unknown')
  })
})
