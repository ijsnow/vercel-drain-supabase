-- drain.vercel_logs: landing table for Vercel log drain deliveries.
--
-- Schema isolation: the table lives in its own `drain` schema, which is
-- deliberately NOT in PostgREST's exposed-schemas list. That means it is
-- unreachable through the public REST API — no anon/authenticated/service
-- role can touch it over HTTPS. The edge function writes to it over a
-- direct Postgres connection (see functions/vercel-drain/sinks/postgres.ts), and
-- humans read it via the SQL editor / a direct connection. Ingestion
-- therefore does not depend on PostgREST being healthy.
--
-- Design notes:
--   * Daily range partitions on "timestamp". Retention is DROP PARTITION,
--     never DELETE: dropping a partition is instant, deleting millions of
--     rows creates a vacuum problem.
--   * Primary key (timestamp, id). Delivery is at-least-once, so inserts
--     are ON CONFLICT DO NOTHING upserts keyed on this. The partition key
--     must be part of the primary key, which is why it is composite.
--   * Hot columns are extracted for filtering; everything else, including
--     the whole proxy object, lives in raw (jsonb).

create schema if not exists drain;

create table drain.vercel_logs (
  id               text        not null,
  "timestamp"      timestamptz not null,  -- Vercel sends unix ms; the edge function converts on insert
  level            text,                  -- info | warning | error | fatal
  source           text,                  -- build|edge|lambda|static|external|firewall|redirect
  environment      text,                  -- production | preview
  request_id       text,
  status_code      int,
  path             text,
  execution_region text,
  trace_id         text,
  message          text,
  raw              jsonb       not null,
  primary key ("timestamp", id)
) partition by range ("timestamp");

comment on table drain.vercel_logs is
  'Vercel log drain events. Written by the vercel-drain edge function over a direct connection; queried via SQL. Not exposed through PostgREST.';

-- BRIN on timestamp: nearly free to maintain on append-only, time-ordered
-- data, and enough for the time-window scans every query starts with.
create index vercel_logs_timestamp_brin
  on drain.vercel_logs using brin ("timestamp");

-- Btree on request_id: the join key, if you ever stamp request_id onto
-- your own rows.
create index vercel_logs_request_id_idx
  on drain.vercel_logs (request_id)
  where request_id is not null;

-- Belt-and-suspenders: the schema is already unexposed, so no API role can
-- reach this table. RLS with no policies is a second lock in case someone
-- later adds `drain` to the exposed-schemas list by accident. The direct
-- connection the drain uses connects as a superuser and bypasses it.
alter table drain.vercel_logs enable row level security;

-- Safety net: a DEFAULT partition catches any row whose day has no
-- explicit partition yet. This decouples "writes keep working" from
-- "cron keeps running": if maintenance lags or stops, inserts land here
-- instead of failing, so a dead cron degrades retention, never ingestion.
--
-- ponytail: known ceiling — if rows for day D leak into default (cron
-- down long enough), create_partition(D) will error until those rows are
-- cleared, so recovery after a prolonged outage is manual. Acceptable:
-- ingestion never stops, which is the property that matters.
create table drain.vercel_logs_default partition of drain.vercel_logs default;

-- Bootstrap partitions for today and tomorrow so the drain can write
-- before the first pg_cron maintenance run. Ongoing partition management
-- lives in 0002.
do $$
declare
  day date;
begin
  for day in select generate_series(current_date, current_date + 1, interval '1 day')::date loop
    execute format(
      'create table if not exists drain.%I partition of drain.vercel_logs for values from (%L) to (%L)',
      'vercel_logs_p' || to_char(day, 'YYYYMMDD'),
      day,
      day + 1
    );
  end loop;
end;
$$;
