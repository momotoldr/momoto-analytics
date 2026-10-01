-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "analytics_session" (
    "session_id" UUID NOT NULL,
    "anon_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "ip_prefix" TEXT,
    "dropped" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_session_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "analytics_event" (
    "event_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "type" TEXT,
    "props" JSONB NOT NULL,

    CONSTRAINT "analytics_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "analytics_identity" (
    "anon_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "analytics_identity_pkey" PRIMARY KEY ("anon_id")
);

-- CreateTable
CREATE TABLE "analytics_job" (
    "name" TEXT NOT NULL,
    "last_run_on" DATE NOT NULL,

    CONSTRAINT "analytics_job_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "analytics_session_anon_id_idx" ON "analytics_session"("anon_id");

-- CreateIndex
CREATE INDEX "analytics_session_started_at_idx" ON "analytics_session"("started_at");

-- CreateIndex
CREATE INDEX "analytics_event_session_id_ts_idx" ON "analytics_event"("session_id", "ts");

-- CreateIndex
CREATE INDEX "analytics_event_ts_idx" ON "analytics_event" USING BRIN ("ts");

-- CreateIndex
CREATE INDEX "analytics_identity_user_id_idx" ON "analytics_identity"("user_id");


-- ── Hand-written ───────────────────────────────────────────────────────────────────

-- The purge job's row, so its first claim is an UPDATE like every later one.
INSERT INTO "analytics_job" ("name", "last_run_on") VALUES ('purge', DATE '1970-01-01');

-- A read-only role for querying by hand in the Railway console, so a typo in an ad-hoc
-- query can't delete anything. Created NOLOGIN: this repo is public, so no password
-- lives here. Enable it once per environment, by hand:
--   ALTER ROLE analytics_ro WITH LOGIN PASSWORD '<generated>';
-- and keep its URL as READONLY_DATABASE_URL on the database service.
-- Roles are cluster-wide, so a database recreated on the same server finds it already there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_ro') THEN
    CREATE ROLE analytics_ro NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO analytics_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analytics_ro;
-- Tables added by later migrations (run as this same owner) are readable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO analytics_ro;
