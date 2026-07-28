-- Schedule daily partition maintenance with pg_cron.
--
-- Retention is configured HERE, in the scheduled command, not by an edge
-- function env var: to change it, edit the number below and re-run the
-- cron.schedule call (scheduling under the same job name replaces the
-- job). 14 days keeps hot logs cheap; anything older lives in the
-- optional Storage archive.
--
-- pg_cron ships with every Supabase project. The guard below only exists
-- so this migration also applies cleanly on plain Postgres (e.g. the CI
-- service container), where pg_cron is not installed; there it just
-- raises a notice and skips scheduling.

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- 00:07 UTC daily: create today's + tomorrow's partitions, drop
    -- partitions older than 14 days.
    perform cron.schedule(
      'vercel-logs-maintenance',
      '7 0 * * *',
      $cmd$ select public.vercel_logs_maintenance(retention_days => 14) $cmd$
    );
  else
    raise notice 'pg_cron is not available; schedule public.vercel_logs_maintenance(14) with your own scheduler';
  end if;
end;
$do$;
