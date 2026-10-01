-- Saved queries for reading the clickstream by hand, in the Railway console
-- (momoto-analytics-db → Data → Query) or `psql` via `railway connect momoto-analytics-db`.
-- Use the read-only `analytics_ro` login for these. In psql, set the variables first:
--   \set sid '0192f1c4-…'    \set uid 'cm…'    \set aid '7c3e91a2-…'
-- In the web console, paste the value in place of :'sid' etc.

-- 0. Latest visits: the starting point when you don't have a sessionId yet
SELECT s.session_id, s.started_at, i.user_id,
       (SELECT e.props->>'route' FROM analytics_event e
         WHERE e.session_id = s.session_id AND e.name = 'page_view' ORDER BY e.ts LIMIT 1) AS entry,
       (SELECT count(*) FROM analytics_event e WHERE e.session_id = s.session_id) AS events,
       s.context->>'viewport' AS viewport, s.context->>'appVersion' AS version,
       s.dropped, s.rejected
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

-- 2. A user's recent visits (userId from momoto-core's database)
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

-- 8. Health of the pipeline itself: events the client evicted (`dropped`) or this server
--    refused (`rejected` — usually a new event name missing from src/allowlist.ts)
SELECT date_trunc('day', started_at) AS day, count(*) AS visits,
       sum(dropped) AS dropped, sum(rejected) AS rejected
FROM analytics_session
WHERE started_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1 DESC;
