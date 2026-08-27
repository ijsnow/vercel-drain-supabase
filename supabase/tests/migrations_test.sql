-- Assertions run against a database that has had all migrations applied.
-- Any failure raises an exception, which makes psql exit non-zero with
-- ON_ERROR_STOP=1. Used by CI; also handy locally:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/0001_logs_table.sql \
--     -f supabase/migrations/0002_partition_maintenance.sql \
--     -f supabase/migrations/0003_retention_cron.sql \
--     -f supabase/tests/migrations_test.sql

-- 1. Today's partition exists and accepts a row for "now".
insert into drain.vercel_logs (id, "timestamp", level, source, request_id, status_code, path, message, raw)
values ('test-1', now(), 'info', 'lambda', 'abc12-1723478400100-deadbeef0000', 200, '/api/x', 'hello', '{"id":"test-1"}');

-- 2. The insert is idempotent under the drain's upsert shape.
insert into drain.vercel_logs (id, "timestamp", level, source, raw)
select id, "timestamp", level, source, raw from drain.vercel_logs where id = 'test-1'
on conflict ("timestamp", id) do nothing;

do $$
declare n bigint;
begin
  select count(*) into n from drain.vercel_logs where id = 'test-1';
  if n <> 1 then
    raise exception 'expected exactly 1 row for test-1, got %', n;
  end if;
end;
$$;

-- 3. Maintenance creates tomorrow's partition.
select drain.vercel_logs_maintenance(14);

do $$
begin
  if to_regclass('drain.vercel_logs_p' || to_char(current_date + 1, 'YYYYMMDD')) is null then
    raise exception 'tomorrow''s partition was not created';
  end if;
end;
$$;

-- 4. A partition past the retention window is dropped, and rows in it go
--    with it (retention via DROP, not DELETE).
select drain.vercel_logs_create_partition((current_date - 30)::date);

insert into drain.vercel_logs (id, "timestamp", raw)
values ('test-old', (current_date - 30)::timestamptz + interval '12 hours', '{}');

select drain.vercel_logs_maintenance(14);

do $$
declare n bigint;
begin
  if to_regclass('drain.vercel_logs_p' || to_char(current_date - 30, 'YYYYMMDD')) is not null then
    raise exception 'expired partition was not dropped';
  end if;
  select count(*) into n from drain.vercel_logs where id = 'test-old';
  if n <> 0 then
    raise exception 'rows from the expired partition survived, got %', n;
  end if;
end;
$$;

-- 5. A partition inside the retention window survives maintenance.
do $$
begin
  if to_regclass('drain.vercel_logs_p' || to_char(current_date, 'YYYYMMDD')) is null then
    raise exception 'today''s partition should not have been dropped';
  end if;
end;
$$;

-- 5b. A row whose day has no explicit partition lands in the DEFAULT
--     partition instead of failing (the cron-lag safety net).
insert into drain.vercel_logs (id, "timestamp", raw)
values ('test-future', (current_date + 3650)::timestamptz, '{}');

do $$
declare n bigint;
begin
  select count(*) into n from only drain.vercel_logs_default where id = 'test-future';
  if n <> 1 then
    raise exception 'far-future row did not land in the default partition, got %', n;
  end if;
end;
$$;

-- 6. Invalid retention is rejected.
do $$
begin
  begin
    perform drain.vercel_logs_maintenance(0);
    raise exception 'maintenance accepted retention_days = 0';
  exception
    when raise_exception then
      if sqlerrm = 'maintenance accepted retention_days = 0' then
        raise;
      end if;
      -- expected: the positive-integer guard fired
  end;
end;
$$;

-- 7. RLS is enabled on the parent table.
do $$
declare enabled boolean;
begin
  select relrowsecurity into enabled from pg_class where oid = 'drain.vercel_logs'::regclass;
  if not enabled then
    raise exception 'row level security is not enabled on vercel_logs';
  end if;
end;
$$;

select 'migrations_test: all assertions passed' as result;
