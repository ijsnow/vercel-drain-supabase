# vercel-drain-supabase

Receive Vercel log drain deliveries into your own Supabase Postgres, in a shape that
can be joined against your application tables.

## Problem

Vercel Drains can forward logs to any HTTPS endpoint, but every turnkey destination
(Axiom, Better Stack, Datadog, Logflare) lands the data somewhere your application
database cannot reach. That means you can see that requests failed, but not *who*
they failed for, without exporting from two systems and reconciling by hand.

Secondary motivation: teams running Vercel plus Supabase often have a non-technical
client or owner. Every additional vendor is an account someone has to hold, pay for,
and remember exists. Keeping logs inside the existing Supabase project adds zero new
services.

## Non-goals

Write these into the README. They are the guardrails against scope creep.

- No query UI or dashboard. Use the Supabase SQL editor.
- No alerting or anomaly detection.
- No Iceberg / Analytics Buckets ingestion. Writing Iceberg from Deno is not viable.
- No OTLP trace drains in v1. Logs only.
- No hosted or multi-tenant version. This is a template you run yourself.
- Not a general log aggregator. It receives Vercel drains, nothing else.

## Architecture

```
Vercel drain  ──signed ndjson──▶  Supabase edge function
                                    │  verify hmac-sha1
                                    │  parse ndjson
                                    │  normalize
                                    ├──▶  logs table (daily partitions)
                                    └──▶  storage archive (optional, gzipped)

logs table  ──join on request_id──▶  application tables
```

The correlation loop is the point of the whole project:

1. App emits a structured line per request containing the Vercel request id plus
   whatever domain identity it knows (user id, tenant id, tRPC procedure).
2. That line arrives back through the drain and lands in the logs table.
3. App also stamps `request_id` onto rows it writes (payments, reservations, audit).
4. Queries join the two on `request_id`.

Without step 1 and 3, the "join" degrades to matching timestamps and paths, which is
guesswork. The correlate package exists to make those steps one line of setup.

## Repo layout

```
vercel-drain-supabase/
├── README.md
├── LICENSE                      # Apache 2.0, matches Supabase
├── packages/
│   ├── drain/                   # JSR, Deno-first, runs in the edge function
│   │   ├── mod.ts               # createDrainHandler({ ... })
│   │   ├── verify.ts            # hmac-sha1, timing-safe, x-vercel-verify
│   │   ├── parse.ts             # ndjson + json array, tolerant of bad lines
│   │   ├── schema.ts            # zod schema for the Vercel log event
│   │   ├── normalize.ts         # event -> row shape
│   │   ├── sinks/
│   │   │   ├── postgres.ts
│   │   │   └── storage.ts
│   │   └── __tests__/
│   │       └── fixtures/        # real payloads, redacted
│   └── correlate/               # npm, runs in the user's app
│       ├── src/trpc.ts          # tRPC middleware
│       ├── src/http.ts          # framework-agnostic helper
│       └── src/index.ts
├── supabase/
│   ├── migrations/
│   │   ├── 0001_logs_table.sql
│   │   ├── 0002_partition_maintenance.sql
│   │   └── 0003_retention_cron.sql
│   └── functions/vercel-drain/index.ts
├── examples/
│   └── tanstack-start-trpc/
├── docs/
│   ├── setup.md
│   ├── queries.md               # the join recipes
│   └── cost.md
└── .github/workflows/ci.yml
```

Two published artifacts because they have different runtimes and different consumers.
`drain` is Deno and goes to JSR so the edge function is a thin import rather than a
copy-pasted blob nobody can update. `correlate` is npm because it runs inside the
user's Vercel app. The SQL is copied rather than packaged, because that is how
Supabase migrations work.

## Design decisions

### Handler returns 200 fast and does exactly one write

Edge functions have a 2s CPU budget per request, and a drain batch can carry several
hundred to a thousand lines. Parse, normalize, one multi-row write. No per-row
awaits, no enrichment calls, no outbound HTTP.

### Use supabase-js, not a direct Postgres connection

This is the decision to defend loudest in the README. Going through PostgREST with
the service role key means connection pooling never becomes the user's problem, and
idempotency is one call:

```ts
await supabase.from('vercel_logs').upsert(rows, {
  onConflict: 'timestamp,id',
  ignoreDuplicates: true,
})
```

Offer postgres.js with `COPY` as an advanced option for high volume, but do not make
it the default. Shipping a template that opens raw connections from an edge function
is how you get issues titled "max client connections reached."

### Idempotency is mandatory

Delivery is at-least-once. Any non-200, including a slow response, produces a retry
and therefore duplicate rows. Primary key on `(timestamp, id)`. The partition key has
to be part of the primary key, which is why it is a composite.

### Daily range partitions, never DELETE

`partition by range (timestamp)`. BRIN index on `timestamp` (nearly free on
append-only time-ordered data), btree on `request_id`. A pg_cron job creates
tomorrow's partition and drops partitions past the retention window. Dropping a
partition is instant; deleting millions of rows creates a vacuum problem.

### Hot columns plus jsonb

Extract the fields people actually filter on. Everything else, including the whole
`proxy` object, goes to jsonb.

```sql
create table vercel_logs (
  id               text        not null,
  timestamp        timestamptz not null,   -- Vercel sends unix ms, convert on insert
  level            text,
  source           text,                   -- build|edge|lambda|static|external|firewall|redirect
  environment      text,                   -- production|preview
  request_id       text,
  status_code      int,
  path             text,
  execution_region text,
  trace_id         text,
  message          text,
  raw              jsonb       not null,
  primary key (timestamp, id)
) partition by range (timestamp);
```

### The verify handshake lives in the same handler

If `VERCEL_VERIFY_CODE` is set, always attach it as a response header on every
request. Otherwise drain setup fails confusingly and that is the first ten GitHub
issues.

### Config is env vars only

No config file format to design, document, or version.

```
VERCEL_DRAIN_SECRET       # hmac secret from the drain config
VERCEL_VERIFY_CODE        # x-vercel-verify value
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
DRAIN_RETENTION_DAYS      # default 14
DRAIN_ARCHIVE_BUCKET      # optional, enables the storage sink
```

### Edge function needs verify_jwt disabled

Vercel does not send Supabase credentials. Set `verify_jwt = false` in
`supabase/config.toml` for this function and rely on the Vercel signature check
inside the handler instead. Document this prominently; it is the single most likely
setup failure.

## Cost notes for docs/cost.md

- Vercel bills drain export at $0.50/GB regardless of destination.
- Supabase database disk is roughly $0.125/GB/month past the 8GB included on Pro.
- Supabase file storage is roughly $0.021/GB/month, about 6x cheaper.
- Therefore: short retention in Postgres, optional gzipped archive to Storage for
  anything longer.
- Recommend excluding the `static` source and using drain sampling rules before
  paying to ingest asset requests.

## Build order

1. **`verify.ts` and `parse.ts` with fixture tests.** No infrastructure required, and
   this is the part that has to be correct. Capture real drain payloads early and
   redact them into `__tests__/fixtures/`.
2. **`0001_logs_table.sql`.** Get the partitioning and PK right before anything
   writes to it.
3. **`0002` / `0003`, partition maintenance and retention.** Test against a Postgres
   service container in CI.
4. **`mod.ts` and the postgres sink.** Wire the handler end to end.
5. **`docs/queries.md`.** Write this *before* the README. If you cannot produce five
   join queries that are obviously worth having, the premise is wrong and you want to
   know on day two, not day ten.
6. **`correlate` package.** tRPC middleware plus the generic helper.
7. **Storage sink**, optional second output.
8. **README and example app.**

## Query recipes to write (docs/queries.md)

These are the artifact that justifies the project. Draft them early.

1. **Reconciliation.** Requests that logged a successful external side effect but
   have no corresponding domain row. Left join on `request_id`, filter for null.
2. **Blast radius.** Distinct affected users for a given error signature, joined
   through sessions, so you can answer "one person or forty" during an incident.
3. **Errors by domain entity.** 5xx grouped by a human-readable name from your own
   tables rather than by opaque UUID in the path.
4. **Background job correlation.** Latency percentiles bucketed by minute, aligned
   against cron run times, filtered to requests touching active records.
5. **Funnel.** Requests to a page versus rows created in the window, for the
   product questions that are not debugging.

## Open questions

- Does `correlate` read `x-vercel-id` or generate its own id? Vercel's own
  `requestId` is the safer join key since it is already in every log row.
- Should `parse.ts` drop malformed lines silently or surface a counter? Leaning
  toward a counter logged once per batch so failures are visible without failing
  the delivery.
- Is a `supabase functions` template plus copy-paste SQL enough, or does this
  eventually want a small CLI? Defer. Copy-paste until someone asks.
- Worth upstreaming a version of the setup doc to `supabase/supabase` as a
  community example. Check whether a comparable webhook-into-partitioned-table
  guide already exists before writing.

## Reference

- Vercel drains overview: <https://vercel.com/docs/drains>
- Log drain schema and formats: <https://vercel.com/docs/drains/reference/logs>
- Drain configuration and verification: <https://vercel.com/docs/drains/using-drains>
- Signature verification: <https://vercel.com/docs/headers/request-headers>
- Supabase edge function limits: <https://supabase.com/docs/guides/functions/limits>
- Supabase function auth and verify_jwt: <https://supabase.com/docs/guides/functions/auth>
- Supabase storage pricing: <https://supabase.com/docs/guides/storage/pricing>
