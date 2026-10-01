/**
 * Minimal structured JSON logger. Keep log entries free of PII and secrets — never log
 * an event body, an anon/session id or a user id; counts and codes only.
 */
type Level = 'info' | 'warn' | 'error'

function emit(level: Level, event: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => emit('info', event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => emit('warn', event, meta),
  error: (event: string, meta?: Record<string, unknown>) => emit('error', event, meta),
}
