import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'

import jwt from 'jsonwebtoken'

export const ORIGIN = 'https://staging.momoto.test'

/** Database suites run only with a database — and CI must never silently skip them. */
export const hasDatabase = !!process.env.DATABASE_URL
if (!hasDatabase && process.env.CI) {
  throw new Error('DATABASE_URL is required in CI: the database tests must run there')
}

export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createApp } = await import('../src/http/app.js')
  const server: Server = createServer(createApp())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

export async function resetDatabase(): Promise<void> {
  const { prisma } = await import('../src/db/client.js')
  await prisma.$executeRaw`TRUNCATE analytics_event, analytics_session, analytics_identity`
  await prisma.$executeRaw`UPDATE analytics_job SET last_run_on = DATE '1970-01-01'`
}

/** A UUIDv7-shaped id (time prefix + random), as the tracker sends. */
export function eventId(ms: number = Date.now()): string {
  const hex = ms.toString(16).padStart(12, '0')
  const rand = randomUUID().replace(/-/g, '')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(13, 16)}-8${rand.slice(17, 20)}-${rand.slice(20, 32)}`
}

export interface WireEvent {
  event_id: string
  event_name: string
  event_type: string | null
  timestamp: number
  data: Record<string, unknown>
}

export function event(
  name: string,
  data: Record<string, unknown> = {},
  ts = Date.now(),
): WireEvent {
  return { event_id: eventId(ts), event_name: name, event_type: null, timestamp: ts, data }
}

export function envelope(events: WireEvent[], overrides: Record<string, unknown> = {}) {
  return {
    request_id: randomUUID(),
    source: 'momoto-fe',
    sdk: { name: 'momoto-tracker', version: '0.1.0' },
    anon_id: randomUUID(),
    session_id: randomUUID(),
    context: { appVersion: 'test', viewport: '390x844' },
    sent_at: Date.now(),
    dropped: 0,
    events,
    ...overrides,
  }
}

/** Posts the way the tracker does: text/plain, from the frontend's origin. */
export function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: ORIGIN, ...headers },
  })
}

export function token(userId: string, secret = process.env.JWT_SECRET!): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: 3600 })
}
