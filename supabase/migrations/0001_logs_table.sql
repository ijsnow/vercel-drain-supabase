-- vercel_logs: landing table for Vercel log drain deliveries.
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

create table public.vercel_logs (
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

comment on table public.vercel_logs is
  'Vercel log drain events. Written by the vercel-drain edge function; joined to application tables on request_id.';

-- BRIN on timestamp: nearly free to maintain on append-only, time-ordered
-- data, and enough for the time-window scans every query starts with.
create index vercel_logs_timestamp_brin
  on public.vercel_logs using brin ("timestamp");

-- Btree on request_id: the join key back to application tables.
create index vercel_logs_request_id_idx
  on public.vercel_logs (request_id)
  where request_id is not null;

-- The service role bypasses RLS, so the edge function can write. With RLS
-- enabled and no policies, anon and authenticated API roles can do nothing,
-- which is exactly right for an operational log table.
alter table public.vercel_logs enable row level security;

-- Bootstrap partitions for today and tomorrow so the drain can write
-- before the first pg_cron maintenance run. Ongoing partition management
-- lives in 0002.
do $$
declare
  day date;
begin
  for day in select generate_series(current_date, current_date + 1, interval '1 day')::date loop
    execute format(
      'create table if not exists public.%I partition of public.vercel_logs for values from (%L) to (%L)',
      'vercel_logs_p' || to_char(day, 'YYYYMMDD'),
      day,
      day + 1
    );
  end loop;
end;
$$;
