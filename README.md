# vercel-drain-supabase

Receive Vercel log drain deliveries into your own Supabase Postgres, in a
shape that can be joined against your application tables.

```
Vercel drain  ──signed ndjson──▶  Supabase edge function
                                    │  verify hmac-sha1
                                    │  parse ndjson
                                    │  normalize
                                    ├──▶  logs table (daily partitions)
                                    └──▶  storage archive (optional, gzipped)

logs table  ──join on request_id──▶  application tables
```

## Why

Vercel drains can forward logs to any HTTPS endpoint, but every turnkey
destination (Axiom, Better Stack, Datadog, Logflare) lands the data
somewhere your application database cannot reach. You can see *that*
requests failed, but not *who* they failed for, without exporting from
two systems and reconciling by hand.

With the logs in your own Postgres, questions like these are single
queries ([docs/queries.md](docs/queries.md) has the SQL):

1. **Reconciliation** — requests that logged a successful external side
   effect but have no corresponding domain row.
2. **Blast radius** — distinct affected users for an error signature:
   one person or forty?
3. **Errors by domain entity** — 5xx grouped by customer email, not by
   opaque UUID in the path.
4. **Background job correlation** — error rates aligned against your own
   job-run table.
5. **Funnel** — requests to a page versus rows created in the window.

A quieter benefit: teams running Vercel plus Supabase often have a
non-technical client or owner, and every extra vendor is an account
someone has to hold, pay for, and remember exists. This adds zero new
services.

## What this is not

Guardrails, stated up front:

- **No query UI or dashboard.** Use the Supabase SQL editor.
- **No alerting or anomaly detection.**
- **No Iceberg / Analytics Buckets ingestion.** Writing Iceberg from
  Deno is not viable.
- **No OTLP trace drains.** Logs only, in v1.
- **No hosted or multi-tenant version.** This is a template you run
  yourself.
- **Not a general log aggregator.** It receives Vercel drains, nothing
  else.

## How it works

Two small packages plus SQL you copy:

| Piece | Runtime | Published as |
| --- | --- | --- |
| [`packages/drain`](packages/drain) | Deno, inside the edge function | JSR (`@ijsnow/vercel-drain-supabase`) |
| [`packages/correlate`](packages/correlate) | Node, inside your Vercel app | npm (`vercel-drain-correlate`) |
| [`supabase/migrations`](supabase/migrations) | Postgres | copied, the way Supabase migrations work |

The correlation loop is the point of the whole project:

1. Your app emits a structured line per request containing the Vercel
   request id plus whatever domain identity it knows (user id, tenant
   id, tRPC procedure). `correlate` makes this one line of setup.
2. That line arrives back through the drain and lands in the logs table.
3. Your app also stamps `request_id` onto rows it writes (payments,
   reservations, audit).
4. Queries join the two on `request_id`.

Without steps 1 and 3, the "join" degrades to matching timestamps and
paths, which is guesswork. The join key is Vercel's own request id (from
the `x-vercel-id` header), because it is already present in every drain
log row.

**[Setup guide →](docs/setup.md)** · **[Query recipes →](docs/queries.md)** · **[Cost notes →](docs/cost.md)**

## Design decisions

### The handler returns 200 fast and does exactly one write

Edge functions have a ~2s CPU budget per request, and a drain batch can
carry several hundred to a thousand lines. Parse, normalize, one
multi-row write per sink. No per-row awaits, no enrichment calls, no
outbound HTTP.

### supabase-js, not a direct Postgres connection

The decision to defend loudest. Going through PostgREST with the service
role key means connection pooling never becomes your problem, and
idempotency is one call:

```ts
await supabase.from("vercel_logs").upsert(rows, {
  onConflict: "timestamp,id",
  ignoreDuplicates: true,
});
```

postgres.js with `COPY` exists as an advanced option for high volume,
but it is deliberately not the default. A template that opens raw
connections from an edge function is how you get issues titled "max
client connections reached."

### Idempotency is mandatory

Drain delivery is at-least-once. Any non-200 — including a slow response
— produces a retry and therefore duplicate deliveries. The primary key
is `(timestamp, id)` and every insert is `ON CONFLICT DO NOTHING`; the
storage archive keys objects by body hash for the same reason. The
partition key has to be part of the primary key, which is why it is
composite.

### Daily range partitions, never DELETE

`partition by range (timestamp)`, BRIN index on `timestamp` (nearly free
on append-only time-ordered data), btree on `request_id`. A pg_cron job
creates tomorrow's partition and drops partitions past the retention
window (default 14 days). Dropping a partition is instant; deleting
millions of rows creates a vacuum problem.

### Hot columns plus jsonb

The fields people actually filter on — `level`, `source`, `environment`,
`request_id`, `status_code`, `path`, `execution_region`, `trace_id`,
`message` — are real columns. Everything else, including the whole
`proxy` object, is preserved in `raw jsonb`.

### The verify handshake lives in the same handler

If `VERCEL_VERIFY_CODE` is set, it is attached as a response header on
*every* response, success or error, so drain verification cannot fail
because you hit the endpoint in an unexpected way.

### The edge function runs with `verify_jwt = false`

Vercel does not send Supabase credentials, so the platform-level JWT
check must be off for this one function (this repo's
`supabase/config.toml` does it). **This is the single most likely setup
failure.** The endpoint is not unauthenticated: every delivery must
carry a valid HMAC-SHA1 signature over the exact body, verified
timing-safely inside the handler.

## Configuration

Env vars only — there is no config file format to design, document, or
version:

| Variable | Required | Purpose |
| --- | --- | --- |
| `VERCEL_DRAIN_SECRET` | yes | HMAC secret from the drain configuration |
| `VERCEL_VERIFY_CODE` | for setup | `x-vercel-verify` value shown during drain creation |
| `SUPABASE_URL` | auto | Injected by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | auto | Injected by Supabase |
| `DRAIN_ARCHIVE_BUCKET` | no | Private Storage bucket; setting it enables the gzip archive sink |

Retention (default 14 days) is configured in SQL, where the cron job
lives — see `supabase/migrations/0003_retention_cron.sql`.

## Repo layout

```
packages/
  drain/          # JSR, Deno-first, runs in the edge function
  correlate/      # npm, runs in your Vercel app
supabase/
  migrations/     # partitioned table, maintenance, retention cron
  functions/
    vercel-drain/ # thin wrapper around packages/drain
  tests/          # SQL assertions, run against Postgres in CI
docs/
  setup.md  queries.md  cost.md
examples/
  tanstack-start-trpc/
```

## Development

```sh
cd packages/drain && deno task test        # handler, parsing, signatures
cd packages/correlate && npm install && npm test
# migrations: see supabase/tests/migrations_test.sql header
```

## License

[Apache 2.0](LICENSE), matching Supabase.
