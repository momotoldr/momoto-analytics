import { PrismaClient } from '@prisma/client'

/**
 * Single shared Prisma client for the process. `tsx watch` reloads modules on change, so
 * the instance is cached on `globalThis` in dev to avoid piling up connection pools.
 *
 * Connections are lazy: a database that is down at boot doesn't stop the server from
 * starting — `/healthz` reports it, and ingest answers 503 until it's back.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
