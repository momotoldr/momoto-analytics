import { defineConfig } from 'vitest/config'

/**
 * Database tests run against `DATABASE_URL` — in CI, the throwaway Postgres service the
 * workflow starts and migrates. They truncate every table, so never point this at a
 * database you care about. Without `DATABASE_URL` they are skipped locally (and fail in CI).
 */
export default defineConfig({
  test: {
    // One shared database: test files must not interleave their truncates.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-secret-0123456789abcdef',
      CORS_ORIGINS: 'https://staging.momoto.test',
      INGEST_RATE_LIMIT: '60',
      IDENTIFY_RATE_LIMIT: '1000',
      RETENTION_DAYS: '90',
    },
  },
})
