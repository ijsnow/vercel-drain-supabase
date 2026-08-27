-- Partition maintenance for drain.vercel_logs.
--
-- Two functions:
--   * drain.vercel_logs_create_partition(day): create one daily partition.
--   * drain.vercel_logs_maintenance(retention_days): ensure today's and
--     tomorrow's partitions exist, then drop partitions entirely past the
--     retention window. Scheduled daily by 0003.
--
-- Partitions are named vercel_logs_pYYYYMMDD; the maintenance function
-- relies on that convention when deciding what to drop.

create or replace function drain.vercel_logs_create_partition(day date)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format(
    'create table if not exists drain.%I partition of drain.vercel_logs for values from (%L) to (%L)',
    'vercel_logs_p' || to_char(day, 'YYYYMMDD'),
    day,
    day + 1
  );
end;
$$;

comment on function drain.vercel_logs_create_partition(date) is
  'Create the daily drain.vercel_logs partition for the given day (idempotent).';

create or replace function drain.vercel_logs_maintenance(retention_days int default 14)
returns void
language plpgsql
set search_path = ''
as $$
declare
  child record;
  child_day date;
  cutoff date;
begin
  if retention_days is null or retention_days < 1 then
    raise exception 'retention_days must be a positive integer, got %', retention_days;
  end if;

  -- Tomorrow's partition is created a day ahead so a missed cron run
  -- never leaves the drain with nowhere to write.
  perform drain.vercel_logs_create_partition(current_date);
  perform drain.vercel_logs_create_partition(current_date + 1);

  cutoff := current_date - retention_days;

  for child in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace n on n.oid = c.relnamespace
    where i.inhparent = 'drain.vercel_logs'::regclass
      and n.nspname = 'drain'
      and c.relname ~ '^vercel_logs_p\d{8}$'
  loop
    child_day := to_date(substring(child.relname from '\d{8}$'), 'YYYYMMDD');
    -- Partition for child_day covers [child_day, child_day + 1). Drop it
    -- once that whole range is older than the cutoff.
    if child_day < cutoff then
      execute format('drop table drain.%I', child.relname);
      raise notice 'dropped partition % (older than % days)', child.relname, retention_days;
    end if;
  end loop;
end;
$$;

comment on function drain.vercel_logs_maintenance(int) is
  'Ensure today''s/tomorrow''s drain.vercel_logs partitions exist and drop partitions older than retention_days.';
