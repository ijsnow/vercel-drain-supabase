# Query recipes

The point of keeping logs in Postgres is that weeks after an incident,
when Vercel's own retention has aged them out, they're still here and
answerable with plain SQL. Run everything in the Supabase SQL editor (or
ask Claude to run it over the Supabase MCP) — both use a direct database
connection, so they reach the `drain` schema even though it is not
exposed through the REST API.

The table is `drain.vercel_logs`. To skip the schema prefix, run
`set search_path = drain, public;` once at the top of your session, then
query `vercel_logs` bare.

Every recipe leads with a `"timestamp"` window — that's what makes them
cheap (see [Notes](#notes-on-writing-your-own) at the bottom).

## 1. What was erroring in a window

The bread-and-butter incident query: errors in a time range, most recent
first.

```sql
select "timestamp", source, status_code, path, message
from drain.vercel_logs
where "timestamp" between '2026-03-14 09:00' and '2026-03-14 11:00'
  and level in ('error', 'fatal')
order by "timestamp" desc
limit 200;
```

## 2. Error signatures, ranked

Which failures dominated a window — group by the shape of the message so
one incident doesn't scroll past as a thousand lines.

```sql
select
  status_code,
  path,
  count(*)                        as hits,
  min("timestamp")                as first_seen,
  max("timestamp")                as last_seen
from drain.vercel_logs
where "timestamp" > now() - interval '24 hours'
  and level in ('error', 'fatal')
group by status_code, path
order by hits desc
limit 30;
```

## 3. Status-code breakdown over time

Is the 5xx rate climbing? Buckets per minute, so you can see the shape of
an incident start and recover.

```sql
select
  date_trunc('minute', "timestamp")               as minute,
  count(*)                                        as requests,
  count(*) filter (where status_code >= 500)      as errors_5xx,
  count(*) filter (where status_code between 400 and 499) as errors_4xx
from drain.vercel_logs
where "timestamp" > now() - interval '3 hours'
  and source in ('lambda', 'edge')
group by 1
order by 1;
```

## 4. Everything about one request

You have a `request_id` (from a Vercel error, a support ticket, or a row
in your own tables). Pull its full timeline across build/edge/lambda:

```sql
select "timestamp", source, level, status_code, path, message, raw
from drain.vercel_logs
where request_id = 'iad1::abc-1741900000000-deadbeef'
order by "timestamp";
```

## 5. Search a specific path or route

Everything that hit an endpoint in a window, e.g. reproducing a checkout
failure:

```sql
select "timestamp", level, status_code, message
from drain.vercel_logs
where "timestamp" > now() - interval '2 days'
  and path like '/api/checkout%'
  and status_code >= 400
order by "timestamp" desc;
```

## 6. Digging into fields that aren't hot columns

Anything not extracted to a real column is still in `raw`. Client IP,
cache status, region, and the full proxy object are all reachable:

```sql
select
  "timestamp",
  path,
  raw->'proxy'->>'clientIp'    as client_ip,
  raw->'proxy'->>'vercelCache' as cache,
  raw->'proxy'->>'region'      as region
from drain.vercel_logs
where "timestamp" > now() - interval '6 hours'
  and status_code = 429            -- e.g. who's getting rate-limited
order by "timestamp" desc
limit 100;
```

## Optional: joining logs to your own tables

Every row carries Vercel's `request_id` (from the `x-vercel-id` header).
If you also stamp that same id onto rows your app writes — add a
`request_id text` column and set it from the incoming request's
`x-vercel-id` header — then log lines and domain rows join directly:

```sql
select l."timestamp", l.status_code, l.path, r.id as reservation_id
from drain.vercel_logs l
join reservations r on r.request_id = l.request_id
where l."timestamp" > now() - interval '1 day'
  and l.status_code >= 500;
```

This is opt-in and app-specific; nothing in this repo sets it up for you.
Skip it unless you have a concrete need to tie a specific log line to a
specific row.

## Notes on writing your own

- Always lead with a `"timestamp"` window. The BRIN index makes time
  filters nearly free; without one you scan every partition.
- `request_id` is indexed; `message` is not. Anchor message searches
  inside a time window and a `level`/`status_code` filter first.
- Anything not extracted to a hot column is still in `raw`:
  `raw->'proxy'->>'clientIp'`, `raw->'proxy'->>'vercelCache'`, etc.
- Quote `"timestamp"` — it is also a type name in Postgres.
