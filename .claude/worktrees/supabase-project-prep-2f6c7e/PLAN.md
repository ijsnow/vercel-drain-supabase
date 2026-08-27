# vercel-drain-supabase — design notes

Receive Vercel log drain deliveries into your own Supabase Postgres, so
your logs outlive Vercel's short retention window and stay queryable with
plain SQL. This document records the design and the decisions behind it;
the README is the user-facing version.

## Problem

Vercel's runtime logs age out fast. The moment you actually want them —
investigating an incident from a couple of weeks ago — they're gone. Every
turnkey drain destination (Axiom, Better Stack, Datadog, Logflare) lands
the data in another vendor account someone has to hold, pay for, and
remember exists.

Primary motivation: keep logs in the Supabase project already in the stack,
retained as long as you choose, searchable with SQL you already know. Zero
new services. This matters most for a team running Vercel + Supabase with a
non-technical client or owner, where the next maintainer inherits every
vendor.

The real consumer is a developer (or Claude over the Supabase MCP) running
incident-search queries against old logs — not the application, and not
PostgREST.

## Non-goals

- No query UI or dashboard. Use the Supabase SQL editor.
- No alerting or anomaly detection.
- No app-side correlation layer. Rows carry Vercel's `request_id`, so you
  *can* join to your own tables if you stamp that id onto your rows, but
  nothing here requires it and there is no companion package.
- No Iceberg / Analytics Buckets ingestion. Writing Iceberg from Deno is
  not viable.
- No OTLP trace drains. Logs only.
- No hosted or multi-tenant version. This is a template you run yourself.
- Not a general log aggregator. It receives Vercel drains, nothing else.

## Architecture

```
Vercel drain  ──signed ndjson──▶  Supabase edge function
                                    │  verify hmac-sha1
                                    │  parse ndjson
                                    │  normalize
                                    ├──▶  drain.vercel_logs (daily partitions)
                                    └──▶  storage archive (optional, gzipped)

drain.vercel_logs  ──plain SQL──▶  incident search, weeks after the fact
```

## Distribution: a self-contained edge function

Everything the function needs lives in one folder,
`supabase/functions/vercel-drain/` — `index.ts` (entrypoint), `handler.ts`
(the pipeline), the `verify`/`parse`/`normalize`/`schema` modules, `sinks/`,
a `deno.json` import map, and `tests/`. You deploy it by copying the folder
and running `supabase functions deploy` — the same shape as the functions
in Supabase's own `examples/edge-functions`. Nothing is published to JSR or
npm; there is no library to install and no import-map indirection to break.
This is deliberately the pattern Supabase uses for the deployable functions
people pick from the dashboard template gallery, so the project could be
upstreamed as a community example.

```
supabase/
├── functions/vercel-drain/
│   ├── index.ts            # Deno.serve(handlerFromEnv(Deno.env.toObject()))
│   ├── handler.ts          # createDrainHandler / handlerFromEnv
│   ├── verify.ts           # hmac-sha1, timing-safe, x-vercel-verify
│   ├── parse.ts            # ndjson + json array, tolerant of bad lines
│   ├── schema.ts           # zod schema for the Vercel log event
│   ├── normalize.ts        # event -> row shape
│   ├── sinks/
│   │   ├── postgres.ts      # direct connection (postgres.js) to the pooler
│   │   └── storage.ts       # optional gzip archive, via the Storage API
│   ├── deno.json           # import map ("lock": false)
│   └── tests/              # deno unit tests + fixtures
├── migrations/
│   ├── 0001_logs_table.sql
│   ├── 0002_partition_maintenance.sql
│   └── 0003_retention_cron.sql
└── tests/migrations_test.sql
scripts/smoke.ts            # local end-to-end: signs a delivery, asserts 200/401
docs/{setup,queries,cost}.md
```

## Design decisions

### Handler returns 200 fast and does exactly one write

Edge functions have a ~2s CPU budget per request, and a drain batch can
carry several hundred to a thousand lines. Parse, normalize, one multi-row
write per sink. No per-row awaits, no enrichment calls, no outbound HTTP
beyond the sink writes.

### Unexposed `drain` schema, written over a direct connection

This is the decision to defend loudest, and it reverses an earlier draft
that used `public` + supabase-js.

The table lives in a `drain` schema that is **not** in PostgREST's
exposed-schemas list, so it is unreachable through the REST API — the same
pattern Supabase uses for its own subsystems (`auth`, `storage`,
`realtime`) and recommends in the "Hardening the Data API" guide for
internal data. supabase-js/PostgREST literally cannot reach an unexposed
schema (`PGRST106`), even with the service-role key, so the write goes over
a **direct Postgres connection** instead.

Two reasons this beats PostgREST here:

1. **True isolation.** Operational logs can carry sensitive data (paths, the
   whole `proxy` object). Keeping the schema off the API surface means a
   leaked service-role key or a stray RLS policy can't expose them.
2. **Ingestion doesn't depend on PostgREST.** If PostgREST's schema cache
   wedges (`PGRST002`), a PostgREST-based sink 500s and logs back up. A
   direct connection keeps writing — which, during an incident, is exactly
   when you want logs landing.

The one hazard of direct connections from an edge function — "max client
connections reached" — is avoided by connecting through Supabase's
transaction-mode pooler (Supavisor, port 6543), which is built for
serverless. The sink uses `postgres.js` with `prepare: false` (required by
the pooler) and `max: 1`, matching Supabase's own `drizzle` and
`postgres-on-the-edge` examples.

### Idempotency is mandatory

Delivery is at-least-once. Any non-200, including a slow response, produces
a retry and therefore duplicate deliveries. Primary key on
`(timestamp, id)`, every insert `on conflict do nothing`; the storage
archive keys objects by body hash for the same reason. The partition key
has to be part of the primary key, which is why it is composite.

### Daily range partitions, never DELETE, with a DEFAULT safety net

`partition by range (timestamp)`, BRIN index on `timestamp` (nearly free on
append-only time-ordered data), btree on `request_id`. A pg_cron job creates
tomorrow's partition and drops partitions past the retention window (default
14 days). Dropping a partition is instant; deleting millions of rows creates
a vacuum problem.

A DEFAULT partition sits underneath as a safety net: if the cron job lags or
stops, rows for a not-yet-created day land there instead of failing, so a
dead cron degrades retention rather than breaking ingestion. (Ceiling: rows
that leak into default after a prolonged cron outage need manual cleanup
before their day's partition can be created; ingestion never stops.)

### Hot columns plus jsonb

Extract the fields people filter on (`level`, `source`, `environment`,
`request_id`, `status_code`, `path`, `execution_region`, `trace_id`,
`message`). Everything else, including the whole `proxy` object, goes to
`raw jsonb`.

### The verify handshake lives in the same handler

If `VERCEL_VERIFY_CODE` is set, attach it as a response header on every
response, success or error, so drain verification can't fail because you hit
the endpoint in an unexpected way.

### Edge function needs verify_jwt disabled

Vercel does not send Supabase credentials. `verify_jwt = false` in
`supabase/config.toml` for this function; the Vercel HMAC signature is the
authentication, checked inside the handler. This is the single most likely
setup failure — document it prominently. (Same rationale as Supabase's own
`stripe-webhooks` example.)

### Config is env vars only

```
VERCEL_DRAIN_SECRET       # hmac secret from the drain config
VERCEL_VERIFY_CODE        # x-vercel-verify value
SUPABASE_DB_URL           # injected; the postgres sink connects through it
DRAIN_DB_URL              # optional override (e.g. force the 6543 pooler)
DRAIN_ARCHIVE_BUCKET      # optional, enables the storage sink
```

Retention (default 14 days) is configured in SQL, in the cron job in
`0003_retention_cron.sql`, not by an env var.

## Cost notes (see docs/cost.md)

- Vercel bills drain export at $0.50/GB regardless of destination.
- Supabase database disk is ~$0.125/GB/month past the 8GB included on Pro.
- Supabase file storage is ~$0.021/GB/month, about 6x cheaper.
- Therefore: short retention in Postgres, optional gzipped archive to
  Storage for anything longer.
- Exclude the `static` source and use drain sampling rules before paying to
  ingest asset requests.

## Open questions / possible follow-ups

- Upstream a version of this to `supabase/supabase` as an
  `examples/edge-functions` entry / dashboard template. Check first whether
  a comparable webhook-into-partitioned-table example already exists.
- The `request_id` column is kept but unused by default; correlation to
  application tables stays an opt-in the user wires up themselves.
- A `supabase functions` template plus copy-paste SQL is the current unit of
  distribution. A small CLI is deferred until someone asks.

## Reference

- Vercel drains overview: <https://vercel.com/docs/drains>
- Log drain schema and formats: <https://vercel.com/docs/drains/reference/logs>
- Drain configuration and verification: <https://vercel.com/docs/drains/using-drains>
- Supabase Hardening the Data API: <https://supabase.com/docs/guides/database/hardening-data-api>
- Supabase edge function → Postgres: <https://supabase.com/docs/guides/functions/connect-to-postgres>
- Supabase function auth and verify_jwt: <https://supabase.com/docs/guides/functions/auth>
