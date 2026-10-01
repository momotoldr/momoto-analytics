# momoto-analytics — Event Ingest Service

> **Status (2026-10-01): A0, A1 and A3 built** (not yet a git repo — the owner creates
> `momotoldr/momoto-analytics`). 33 tests against a real Postgres (CI runs them on a
> Postgres 17 service), boot test, migration drift check, and an end-to-end check: the real
> tracker, leaving a real page, delivered a visit cross-origin that query 1 read back in
> order. A2 (Railway staging) and A4 (production) are provisioning, done by the owner.
> Changes from this plan, made while building:
> - **Ingest rate limit 600 / 10 min / IP, not 60** (`INGEST_RATE_LIMIT`); identify 60.
>   Indonesian mobile carriers put many phones behind one IP (CGNAT), and one busy visit
>   alone can send a batch every 10 s — 60 would have dropped real data.
> - **The daily purge claims its day in an `analytics_job` row** (a conditional UPDATE)
>   instead of `pg_try_advisory_lock`: advisory locks are per connection, and Prisma's pool
>   doesn't pin one.
> - Extra columns: `analytics_session.source`, `.rejected` (server-refused events, separate
>   from the client's `dropped`), `analytics_event.type`.
> - Requests whose `Origin` isn't in `CORS_ORIGINS` get **403** — CORS alone doesn't stop a
>   simple cross-site POST from landing.
> - `analytics_ro` is created **NOLOGIN** (public repo, no password in it); enable once per
>   environment with `ALTER ROLE analytics_ro WITH LOGIN PASSWORD '…'`.
> - `npm install-scripts approve` is recorded in `package.json` (`allowScripts`) for Prisma
>   and esbuild: npm 11.19 (Railway's and CI's) warns on unapproved install scripts.

A small backend service that receives tracking events from `@momotoldr/tracker` and
stores them in **its own Postgres**. There is no dashboard. The events are **queried
directly in Railway**, usually by `sessionId`, to see what one visit did. The service
sits beside `momoto-core`, `momoto-realtime`, `momoto-notify` and `momoto-peer` and
follows their conventions:
- Express + TypeScript;
- Node 24 (`engines.node: "24.x"`);
- `node dist/index.js` as PID 1;
- `/healthz`;
- `staging` → staging and `main` → production on Railway, with Wait for CI;
- shared helpers (logger, rate limiter, env loading) **duplicated on purpose**.

Related plans:
- [`docs/PLAN-tracker.md`](../docs/PLAN-tracker.md): the client library and the
  wire format (§5).
- [`momoto-fe/docs/plans/PLAN-observability.md`](../momoto-fe/docs/plans/PLAN-observability.md):
  what Momoto tracks, and privacy.

**Decided 2026-09-29:**
- separate service and separate database;
- **no portal UI**: querying is SQL against the analytics database in Railway;
- as a result, **`momoto-core` and `momoto-portal` need no changes at all.**

**Legend:** DoD = Definition of Done.

---

## 1. Responsibilities

The service does exactly three things:
1. **Ingest:** `POST /v1/b` (batch) and `POST /v1/e` (single), public.
2. **Identify:** `POST /v1/b/identify` links `anonId → userId`, so "what did user X do"
   is answerable. `DELETE /v1/b/identify` unlinks it.
3. **Retention:** a daily purge.

It doesn't call any other service, and no service calls it. The browser is its only
client.

**The product must not notice if this service is down.** The library is
lossy-with-retry and never blocks, and nothing else depends on this service.

---

## 2. Trust

| caller | routes | protection |
| --- | --- | --- |
| anyone | `/v1/b`, `/v1/e` | event-name allowlist, scalar-only props, size caps, per-IP rate limit, `event_id` dedupe. There's no token because a beacon can't carry headers (library plan §3.1). |
| a signed-in user | `/v1/b/identify` | access token verified with the **shared `JWT_SECRET`**, the same arrangement `momoto-realtime` has (core signs, the others verify). `verifyAccessToken.ts` is copied from realtime. Only `sub` is used. |
| you | the database | Railway access. Plus a read-only Postgres role for day-to-day querying (§6). |

**JWT_SECRET is shared by three services now.** A mismatch doesn't fail at boot:
identify just answers 401, and the FE ignores that, so it would be silent. Two
safeguards:
- the deploy checklist includes "sign in on staging and see one `AnalyticsIdentity`
  row";
- the service logs `identify.unauthorized` at warn level.

---

## 3. HTTP API

**`POST /v1/b`** and **`POST /v1/e`**. The envelope is defined in library plan §5.
Body is `text/plain` JSON, and the response is `202`.

- `express.text({ type: 'text/plain', limit: '64kb' })`, then `JSON.parse`. A bad body
  gets `400`, which the library never retries.
- **Allowlist `event_name`**, from momoto-fe's `MomotoEvents`, copied into
  `src/allowlist.ts` (the CI drift check is in §7). Unknown names and non-scalar `data`
  are **dropped and counted**, not rejected, so one stale event can't sink a batch.
- Cap at 100 events per request. **Rate limit** ~60 requests / 10 min / IP.
- Correct skew: `ts = timestamp + (receivedAt − sent_at)`, clamped to ±24 h.
- One transaction per request:
  - upsert `AnalyticsSession` (context, `ipPrefix`, `dropped += n`);
  - `createMany({ skipDuplicates: true })` into `AnalyticsEvent`, which makes it
    idempotent on `event_id`.
- A DB error gets `503`: the library retries, then keeps the batch.
- **CORS:** `CORS_ORIGINS` = the FE origins, `credentials: false`.

**`POST /v1/b/identify`**: `Authorization: Bearer <access token>`, body `{ anonId }`,
then upsert `AnalyticsIdentity(anonId, userId, lastSeenAt = now)`. It's a normal CORS
request, called on login and on session restore, not on unload. Rate limit 20 / 10 min /
IP.

**`DELETE /v1/b/identify`**: same auth. Deletes every `AnalyticsIdentity` row for the
token's `sub`. The FE calls it **just before** `DELETE /auth/me`, while the token is
still valid. It's best-effort, and the 90-day expiry in §5 is the backstop. See
[Privacy](#privacy-without-a-core-dependency).

**`GET /healthz`**: `{ status, uptime, db: 'up' | 'down' }`, **always 200** while the
process can serve. Railway shouldn't restart a healthy process over a DB blip, and
ingest `503`s let the library hold events until the DB is back.

### Privacy without a core dependency

There are no foreign keys to core and no service-to-service calls, so an account
deletion can't cascade here. Instead:
1. **Best-effort unlink:** the FE's `useDeleteAccount` calls `DELETE /v1/b/identify`
   first.
2. **Guaranteed expiry:** the daily job deletes identity rows whose `lastSeenAt` is older
   than the raw-event retention.

Any link from an account to its clickstream is therefore gone at deletion, or at the
latest when that clickstream itself is purged. The events are keyed on random
`anonId`/`sessionId` values, which point at nobody once the identity row is gone. The
privacy page says exactly this.

---

## 4. Data model

**Measured 2026-09-29:** 1 M synthetic events (12,500 visits × 80 events, realistic props)
on a local Postgres 17. The first-draft schema (text ids, `context` copied onto every
row, four btree indexes) cost **754 bytes per event**. This one costs **278**.

```prisma
/// One row per visit. Everything constant for the visit lives here, not on each event.
model AnalyticsSession {
  sessionId String   @id @db.Uuid
  anonId    String   @db.Uuid
  startedAt DateTime @db.Timestamptz
  context   Json     // appVersion, env, flags, locale, viewport… (~220 B, once per visit)
  ipPrefix  String?  // /24 for IPv4, /48 for IPv6. Enough to spot abuse, not a person.
  dropped   Int      @default(0)
  @@index([anonId])
  @@index([startedAt])
}

model AnalyticsEvent {
  eventId   String   @id @db.Uuid  // UUIDv7 from the library: time-ordered, so the PK index
                                    // is append-only, and it doubles as the dedupe key
  sessionId String   @db.Uuid
  name      String
  ts        DateTime @db.Timestamptz
  props     Json
  @@index([sessionId, ts])          // the main query: one visit's timeline, 0.03 ms at 1 M rows
}
// + raw SQL in the migration: CREATE INDEX … USING brin (ts). It is 24 kB (vs 35 MB for
//   a (name, ts) btree) and enough for "errors in the last day" scans.

model AnalyticsIdentity {
  anonId     String   @id @db.Uuid
  userId     String
  lastSeenAt DateTime @db.Timestamptz
  @@index([userId])
}
```

Tables and columns are mapped to snake_case (`@@map` / `@map`: `analytics_event.session_id`),
so hand-written SQL in the Railway console doesn't need quoted identifiers.

---

## 5. Retention and volume

Assumptions: 80 events per visit, 4 visits per monthly active user; the beta assumes
~100 testers × 8 visits. Size is the measured 278 B/event.

| scale | events / month | growth / month | kept (90 d) | avg write rate |
| --- | --- | --- | --- | --- |
| closed beta | 64 k | 18 MB | 54 MB | — |
| 1 k MAU | 320 k | 89 MB | 0.27 GB | 0.1 event/s |
| 10 k MAU | 3.2 M | 0.9 GB | 2.7 GB | 1.2 events/s |
| 100 k MAU | 32 M | 8.9 GB | 27 GB | 12 events/s (< 1 batch insert/s) |

- **Kept 90 days, then deleted (decided 2026-09-30).** Without a dashboard there's no daily rollup to preserve
  history, so the raw window *is* the history. 90 days covers comparing a release with
  the one before it. It's one env var (`RETENTION_DAYS`), and it's cheap at our size in
  a database of its own.
- **For scale:** one saved strip (2.91 MB in R2, `PUBLIC-SCALE.md`) weighs the same as
  about 10,000 events, which is roughly 130 visits.
- **Query speed:** one visit's timeline is instant at any size (index). An ad-hoc
  funnel over a week scans ~1 M rows per 10k MAU. That took 310 ms on an M4 Pro, so
  about a second on Railway, which is fine for a query you run by hand.
- **Levers**, if it grows past this:
  1. `VITE_ANALYTICS_SAMPLE_RATE` (per visit, so funnels stay valid);
  2. a shorter window;
  3. monthly partitions, so retention becomes `DROP PARTITION` instead of a big
     `DELETE` + vacuum;
  4. a daily rollup table, if long-term trends are ever wanted.

---

## 6. Querying in Railway

**Where:**
- **Browsing:** the Railway dashboard, under `momoto-analytics-db` → **Data**. It lists
  tables and rows and lets you filter by column.
- **SQL:** `railway connect momoto-analytics-db` opens `psql` from the terminal. Or
  point TablePlus/psql at the service's `DATABASE_PUBLIC_URL`.
- **Use a read-only role for SQL.** The first migration creates an `analytics_ro` login
  with `SELECT` only. Its URL is kept as a Railway variable on the DB service
  (`READONLY_DATABASE_URL`), so a typo in an ad-hoc query can't delete anything. The
  owner URL is for migrations only.

**How you get a `sessionId` to look up:**
1. **Latest visits:** query 0 below.
2. **From a user:** their `userId` from core's DB (the portal's Users page), then
   query 2.
3. **From an error:** query 4 lists visits with a `client_error`.

**Saved queries.** They ship in the repo as `queries.sql` and are pasted into the
console as needed:

```sql
-- 0. Latest visits: the starting point when you don't have a sessionId yet
SELECT s.session_id, s.started_at, i.user_id,
       (SELECT e.props->>'route' FROM analytics_event e
         WHERE e.session_id = s.session_id AND e.name = 'page_view' ORDER BY e.ts LIMIT 1) AS entry,
       (SELECT count(*) FROM analytics_event e WHERE e.session_id = s.session_id) AS events,
       s.context->>'isMobile' AS mobile, s.context->>'appVersion' AS version
FROM analytics_session s
LEFT JOIN analytics_identity i ON i.anon_id = s.anon_id
ORDER BY s.started_at DESC LIMIT 50;

-- 1. One visit, in order: THE query
SELECT e.ts, e.name, e.props
FROM analytics_event e
WHERE e.session_id = :'sid'
ORDER BY e.ts;

-- …and its context (app version, flags, device)
SELECT * FROM analytics_session WHERE session_id = :'sid';

-- 2. A user's recent visits (userId from core's DB)
SELECT s.session_id, s.started_at, s.context->>'appVersion' AS version,
       (SELECT count(*) FROM analytics_event e WHERE e.session_id = s.session_id) AS events
FROM analytics_identity i
JOIN analytics_session s ON s.anon_id = i.anon_id
WHERE i.user_id = :'uid'
ORDER BY s.started_at DESC LIMIT 20;

-- 3. Everything one browser did (guest before sign-in, too)
SELECT s.session_id, e.ts, e.name, e.props
FROM analytics_session s JOIN analytics_event e USING (session_id)
WHERE s.anon_id = :'aid' ORDER BY e.ts;

-- 4. Visits with a client error in the last 24 h
SELECT DISTINCT ON (session_id) session_id, ts, props->>'source' AS source, props->>'name' AS error
FROM analytics_event
WHERE name = 'client_error' AND ts > now() - interval '1 day'
ORDER BY session_id, ts DESC;

-- 5. Booth funnel, last 7 days (distinct visits per step)
SELECT name, count(DISTINCT session_id) AS visits
FROM analytics_event
WHERE ts > now() - interval '7 days'
  AND name IN ('booth_mode_selected','camera_granted','peer_connected','session_started',
               'capture_completed','strip_created','unlock_clicked')
GROUP BY name ORDER BY visits DESC;

-- 6. Share of connections that needed TURN
SELECT round(100.0 * avg((props->>'viaTurn')::boolean::int), 1) AS pct_turn, count(*)
FROM analytics_event WHERE name = 'peer_connected' AND ts > now() - interval '30 days';

-- 7. Untracked clicks per route: the to-do list for data-track ids
SELECT props->>'route' AS route, props->>'el' AS el, count(*)
FROM analytics_event
WHERE name = 'click' AND props->>'id' IS NULL AND ts > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

---

## 7. Repo, CI, deploy

- **Repo:** `momotoldr/momoto-analytics`, **public** like the other backends (decided
  2026-10-01). Turn on secret scanning + push protection. The service holds secrets
  only in Railway variables, never in the repo.

  ```
  src/
    index.ts        # boot, SIGTERM → close server → disconnect prisma → exit 0
    config/env.ts   # loadEnv.ts
    http/           # app.ts, routes/{ingest,identify}.ts
    auth/           # verifyAccessToken.ts (copied from realtime)
    jobs/purge.ts   # daily; see below
    lib/            # logger, rateLimiter, ipPrefix
    allowlist.ts
  prisma/schema.prisma, prisma/migrations/
  queries.sql       # §6
  ```

- **Daily purge:** a `setInterval` running hourly that acts once per day, set up like
  core's sweeper (`try/catch`, `unref()`), guarded by `pg_try_advisory_lock` because
  Railway briefly runs two instances during a deploy. It:
  - deletes `AnalyticsEvent` rows older than `RETENTION_DAYS` in batches of 10k;
  - deletes `AnalyticsSession` rows with no events left;
  - deletes `AnalyticsIdentity` rows with `lastSeenAt` older than `RETENTION_DAYS`;
  - sweeps the rate-limit windows.
- **Env:**
  - `DATABASE_URL` (`connection_limit=5`)
  - `JWT_SECRET` (variable reference to core's)
  - `CORS_ORIGINS`
  - `TRUST_PROXY`
  - `RETENTION_DAYS` (90)
  - `PORT`
- **CI** (`ci.yml`, same shape as core's):
  - format / lint / typecheck / build;
  - Postgres 17 service, `migrate deploy`, and the `migrate diff --exit-code` drift
    check;
  - a boot test (`/healthz` 200, then SIGTERM → exit 0);
  - an **allowlist drift check** that reads momoto-fe's `src/analytics/events.ts` at
    `staging` and fails if a name is missing from `allowlist.ts`. momoto-fe is public, so a
    plain `actions/checkout` with `repository: momotoldr/momoto-fe` and `ref: staging`
    needs no token. If momoto-fe ever goes private, a workflow's `GITHUB_TOKEN` can't
    read it. The check would then need a secret `FE_READ_TOKEN`: a fine-grained token
    with Contents: read on momoto-fe only.
- **Railway (both environments):**
  - a new `momoto-analytics` service plus a **fresh** Postgres `momoto-analytics-db`. A
    duplicated Postgres service has no volume.
  - start `node dist/index.js`;
  - `preDeployCommand ["npm run db:deploy"]`;
  - `healthcheckPath /healthz`, drain 15 s;
  - GitHub trigger on `staging` / `main` with Wait for CI.
  - Set `JWT_SECRET` as a variable reference *before* the first deploy. It resolves at
    deploy time; if it was set afterwards, redeploy.
- **Domains (decided 2026-09-30):** `e.momotoldr.com` and `e-staging.momotoldr.com`.
  They are deliberately meaningless. Content-blocker rules key on words such as `track`,
  `analytics`, `collect`, `stats`, `metrics`, `beacon` and `pixel`, and a single letter
  matches none of them. Together with the neutral `/v1/b` path, this is why `track.` and
  `tracker.` were rejected. The `-staging.` form keeps the FE env guard's naming rule. A2
  still checks it with uBlock Origin and Brave Shields.
- **FE changes this causes:**
  - `VITE_ANALYTICS_URL`, required when `VITE_ANALYTICS_ENABLED=true`;
  - both hosts in `connect-src`;
  - the unlink call in `useDeleteAccount`.
- **Core / portal changes:** none.
- **Cost:** one small always-on Node process (~60–80 MB), plus a Postgres sized by §5.
  Expect a few dollars a month at beta scale.

**Deploy order:** analytics DB + service on staging → FE flag on in staging → the same
on prod.

---

## 8. Phases

### A0 — Scaffold *(½ day)*
Repo, tooling, CI (without the allowlist check), `/healthz`, SIGTERM handling, schema +
first migration (including `analytics_ro` and the BRIN index), `queries.sql`.
**DoD:** CI green; the boot test passes; `migrate diff` is clean.

### A1 — Ingest + identify *(1½ days)*
`/v1/b`, `/v1/e`, `POST`/`DELETE /v1/b/identify`, allowlist, caps, rate limits, skew,
dedupe.
**DoD:**
- Replaying the same batch twice stores its events once.
- An unknown event name is dropped and counted, and the rest of the batch is kept.
- A 101-event request gets 400; the 61st request in 10 min gets 429.
- A signed-in identify writes one row, and a DELETE removes all of that user's rows; a
  bad token gets 401.
- A beacon sent from the FE origin lands without a preflight.

### A2 — Staging *(½ day)*
Service, DB, domain, variables, triggers, the read-only role's URL. Add the allowlist
drift check once momoto-fe has `events.ts`.
**DoD:**
- A staging deploy builds only after CI passes.
- A batch from staging reaches `e-staging.momotoldr.com` with uBlock Origin
  (default lists) enabled, and with Brave Shields up.
- `/healthz` reports `db: up`.
- Browsing staging with the FE flag on (library L6) and then running **query 1 with the
  current `sessionId`** returns the visit in order.
- A sign-in produces one identity row.

### A3 — Purge *(½ day)*
**DoD:** with synthetic data 100 days old, one run leaves exactly 90 days of events,
sessions and identities, and a second run changes nothing.

### A4 — Production *(½ day)*
**DoD:** a real prod session in the beta can be read back with query 1, and the deploy
checklist (identity row after sign-in) passes.

**Total: about 3½ working days.** It runs alongside the library's L1–L5, and A2 must be
on staging before library L6.

---

## 9. Decisions needed

1. ~~Domains~~ **Decided:** `e.momotoldr.com` / `e-staging.momotoldr.com`.
2. ~~Retention~~ **Decided 2026-09-30:** 90 days (`RETENTION_DAYS=90`) for events,
   visits and identity links. There is no rollup, so nothing older survives.
