/**
 * Runs the retention purge now, regardless of whether today's daily run already happened.
 *
 *   npm run purge                      # local database (.env.local / .env)
 *   node --env-file=.env.staging --import tsx scripts/purge.ts
 */
import '../src/config/loadEnv.js'

import { env } from '../src/config/env.js'
import { prisma } from '../src/db/client.js'
import { purge } from '../src/jobs/purge.js'

const result = await purge(env.retentionDays)
console.log(`Purged (older than ${env.retentionDays} days):`, result)
await prisma.$disconnect()
