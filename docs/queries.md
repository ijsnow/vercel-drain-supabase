# Query recipes

These queries are the reason the logs live in your database instead of a
logging vendor: every one of them joins `vercel_logs` against your own
application tables, which no external destination can do.

They assume the correlation loop from the README is in place:

1. Your app emits one structured line per request via the `correlate`
   package. The line is JSON with a `vdc` marker, the Vercel request id,
   and whatever identity the app knows (`userId`, `procedure`, ...). It
   arrives back through the drain as an ordinary log row.
2. Your app stamps `request_id` onto rows it writes (payments,
   reservations, audit entries).

The example application tables (`payments`, `reservations`, `sessions`,
`users`) are stand-ins — substitute your own. Run everything in the
Supabase SQL editor.

## Setup: a view over the correlation lines

The `correlate` package emits messages shaped like:

```json
{"vdc":1,"requestId":"dxb2k-1723478400100-8f3a21c9d4e0","procedure":"reservations.create","userId":"..."}
```

`JSON.stringify` writes keys in insertion order and `vdc` is always first,
so the rows are cheap to find with a prefix match. Pull them into a view
once and every recipe below gets `user_id` per request:

```sql
create or replace view public.vercel_log_identity as
select
  l.request_id,
  l."timestamp",
  (l.message::jsonb) ->> 'userId'    as user_id,
  (l.message::jsonb) ->> 'procedure' as procedure,
  (l.message::jsonb) - 'vdc' - 'requestId' as identity
from public.vercel_logs l
where l.message like '{"vdc":1%'
  and l.request_id is not null;
```

## 1. Reconciliation: side effects with no domain row

"The logs say we charged the card; do we have the payment?" Requests that
logged a successful charge but have no corresponding `payments` row —
the bug class where an external side effect happened and the database
write after it did not:

```sql
select
  l.request_id,
  l."timestamp",
  i.user_id,
  l.path
from public.vercel_logs l
left join public.vercel_log_identity i using (request_id)
left join public.payments p on p.request_id = l.request_id
where l."timestamp" > now() - interval '1 day'
  and l.message like '%charge.succeeded%'   -- your app's success marker
  and p.id is null
order by l."timestamp" desc;
```

## 2. Blast radius: one person or forty?

During an incident, count distinct affected users for an error signature
instead of guessing from raw log volume:

```sql
select
  count(distinct i.user_id)                as affected_users,
  count(*)                                 as failing_requests,
  min(l."timestamp")                       as first_seen,
  max(l."timestamp")                       as last_seen
from public.vercel_logs l
join public.vercel_log_identity i using (request_id)
where l."timestamp" > now() - interval '2 hours'
  and l.level = 'error'
  and l.message like '%card_declined%';    -- the signature under investigation
```

Add `group by i.user_id` with a `having count(*) > 3` to find the users
hit repeatedly — they are the ones to email.

## 3. Errors by domain entity, not by UUID

5xx counts grouped by a human-readable name from your own tables, rather
than by an opaque id embedded in the path:

```sql
select
  u.email                        as user_email,
  count(*)                       as errors,
  array_agg(distinct l.path)     as paths
from public.vercel_logs l
join public.vercel_log_identity i using (request_id)
join public.users u on u.id = i.user_id::uuid
where l."timestamp" > now() - interval '1 day'
  and l.status_code >= 500
group by u.email
order by errors desc
limit 20;
```

The same shape works for any entity: join `reservations` through
`request_id` and group by property name, join `organizations` and group
by plan tier, and so on.

## 4. Background job correlation

"Is the nightly sync what makes the API slow?" Latency-ish signal (error
and warning rates per minute) aligned against your own job-run table,
filtered to requests that touched records the job was updating:

```sql
select
  date_trunc('minute', l."timestamp")                 as minute,
  count(*)                                            as requests,
  count(*) filter (where l.status_code >= 500)        as errors,
  bool_or(j.id is not null)                           as job_running
from public.vercel_logs l
left join public.job_runs j
  on l."timestamp" between j.started_at and j.finished_at
  and j.job_name = 'nightly-sync'
where l."timestamp" > now() - interval '6 hours'
  and l.source in ('lambda', 'edge')
group by 1
order by 1;
```

If you log durations in your correlate line (`{"durationMs": 1832}`),
swap the error count for
`percentile_cont(0.95) within group (order by (i.identity->>'durationMs')::int)`.

## 5. Funnel: traffic versus outcomes

The product question, not the debugging one: how many requests hit the
booking page versus how many reservations exist for the same window?

```sql
with traffic as (
  select date_trunc('hour', "timestamp") as hour, count(*) as page_hits
  from public.vercel_logs
  where "timestamp" > now() - interval '7 days'
    and path = '/book'
    and source in ('lambda', 'edge')
    and status_code < 400
  group by 1
),
outcomes as (
  select date_trunc('hour', created_at) as hour, count(*) as reservations
  from public.reservations
  where created_at > now() - interval '7 days'
  group by 1
)
select
  t.hour,
  t.page_hits,
  coalesce(o.reservations, 0) as reservations,
  round(100.0 * coalesce(o.reservations, 0) / t.page_hits, 1) as conversion_pct
from traffic t
left join outcomes o using (hour)
order by t.hour;
```

## Notes on writing your own

- Always lead with a `"timestamp"` window. The BRIN index makes time
  filters nearly free; without one you scan every partition.
- `request_id` is indexed; `message` is not. Anchor message searches
  inside a time window and a `level`/`status_code` filter first.
- Anything not extracted to a hot column is still in `raw`:
  `raw->'proxy'->>'clientIp'`, `raw->'proxy'->>'vercelCache'`, etc.
- Quote `"timestamp"` — it is also a type name in Postgres.
