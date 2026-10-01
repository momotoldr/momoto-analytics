import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { clientIp } from '../src/lib/clientIp.js'

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
