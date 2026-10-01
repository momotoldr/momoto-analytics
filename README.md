# momoto-analytics

Receives tracking events from [`@momotoldr/tracker`](https://github.com/momotoldr/momoto-tracker)
and stores them in **its own Postgres**. There is no dashboard: events are read with SQL in
Railway, usually one visit at a time.

Nothing in the product depends on it. The tracker never blocks and keeps (then retries)
what it couldn't send, so this service being down costs data, never a broken page.
momoto-core and momoto-portal don't call it, and it calls nothing.

## API

| route | auth | |
| --- | --- | --- |
| `POST /v1/b` | none (beacons can't send headers) | a batch: the tracker's envelope as `text/plain` JSON → `202` |
| `POST /v1/e` | none | one real-time event, same envelope → `202` |
| `POST /v1/b/identify` | `Bearer` access token from momoto-core | `{ anonId }` — links this browser to the signed-in user → `204` |
| `DELETE /v1/b/identify` | same | unlinks every browser from the user (call before deleting the account) → `204` |
| `GET /healthz` | — | `{ status, uptime, db: 'up' \| 'down' }`; 200 unless shutting down |

What protects the public endpoints, since they can't be authenticated:

- an **allowlist of event names** (`src/allowlist.ts`): unknown names are dropped and
  counted in `analytics_session.rejected`, the rest of the batch is kept;
- **scalar props only**, bounded sizes, at most 100 events per request, 64 KB per body;
- a **per-IP rate limit** (`INGEST_RATE_LIMIT` per 10 min, answered with `429` + `Retry-After`);
- requests carrying an `Origin` must come from `CORS_ORIGINS` (`403` otherwise).

Delivery from the tracker is at-least-once. `event_id` (a UUIDv7) is the primary key and
inserts skip duplicates, so a resent batch is stored once.

**Adding an event to the frontend means adding its name to `src/allowlist.ts` too.**
Otherwise it is silently dropped — watch `analytics_session.rejected`.

## Data

| table | one row per | notes |
| --- | --- | --- |
| `analytics_session` | visit (`session_id`) | browser (`anon_id`), first-batch context, `/24` or `/48` IP prefix, `dropped`, `rejected` |
| `analytics_event` | event | `name`, `ts` (skew-corrected), `type`, `props` (jsonb) |
| `analytics_identity` | browser linked to an account | `user_id` is momoto-core's; no foreign key (other database) |
| `analytics_job` | daily job | the purge claims its day here, so overlapping instances never both run it |

About 280 bytes per event. **Everything older than `RETENTION_DAYS` (90) is deleted daily**
(events, then visits with no events left, then identity links), so no account stays
linked to its clickstream longer than the clickstream itself exists.

## Querying

Use the **read-only role** for ad-hoc SQL, so a typo can't delete anything. The first
migration creates `analytics_ro` with `SELECT` only, **without a login** (this repo is
public, so no password lives in it). Enable it once per environment:

```sql
ALTER ROLE analytics_ro WITH LOGIN PASSWORD '<generate one>';
```

Keep the resulting URL as `READONLY_DATABASE_URL` on the database service in Railway. Then
query. The main query is "one visit, in order":

```sql
SELECT ts, name, props FROM analytics_event WHERE session_id = '<id>' ORDER BY ts;
```

## Run locally

```bash
cp .env.example .env.local   # point DATABASE_URL at a local, separate database
npm install
npm run db:migrate           # applies migrations to that database
npm run dev                  # http://localhost:3004
npm test                     # needs DATABASE_URL — the suites TRUNCATE its tables
```

## Deploy (Railway)

- A **fresh** Postgres service (`momoto-analytics-db`) — never a duplicate of core's.
- Start `node dist/index.js` (node as PID 1, so SIGTERM reaches it); pre-deploy
  `npm run db:deploy`; health check `/healthz`.
- Variables: `DATABASE_URL` (reference to the database, with `?connection_limit=5`),
  `JWT_SECRET` (a **reference to momoto-core's** — set before the first deploy, it
  resolves at deploy time), `CORS_ORIGINS`, `TRUST_PROXY=1`, and
  **`CLIENT_IP_HEADER=cf-connecting-ip`** — behind Cloudflare, `req.ip` is Railway's edge,
  not the visitor. Keep the service on the Cloudflare domain only (no `*.up.railway.app`
  domain), since a request that skips Cloudflare could forge that header.
- Domains: `e.momotoldr.com` / `e-staging.momotoldr.com`, deliberately meaningless so
  content blockers don't match them.
- After deploying: sign in on the frontend and check a row appears in
  `analytics_identity`. A `JWT_SECRET` that differs from core's fails nowhere else — identify
  just returns 401, logged as `identify.unauthorized`.
