# vercel-drain-supabase

> Designed, built and documented almost entirely with Claude. I built this for a client of mine where I am the sole developer and maintainer for a small not-for-profit. My goal was to have durable storage for logs outside of the Vercel allowances, without adding more services for my client to keep track of in their bills. So far I mostly turn the drain on during weekends, which are periods of high usage for the site where I'm not monitoring things too closely. There are definitely better solutions that are built for this purpose, but for this client, this does the job!

Receive Vercel log drain deliveries into your own Supabase Postgres, so
your logs outlive Vercel's short retention window and stay queryable with
plain SQL.

```
Vercel drain  ──signed ndjson──▶  Supabase edge function
                                    │  verify hmac-sha1
                                    │  parse ndjson
                                    │  normalize
                                    ├──▶  logs table (daily partitions)
                                    └──▶  storage archive (optional, gzipped)

logs table  ──plain SQL──▶  incident search, weeks after the fact
```

## Why

Vercel's runtime logs age out fast. The moment you actually want them -
investigating an incident from two or three weeks ago - they're gone, and
every turnkey drain destination (Axiom, Better Stack, Datadog, Logflare)
is another vendor account someone has to hold, pay for, and remember
exists.

This keeps the logs in Postgres you already run, retained as long as you
choose, and searchable with SQL you already know:

```sql
select "timestamp", source, level, status_code, path, message
from drain.vercel_logs
where "timestamp" between '2026-03-01' and '2026-03-02'
  and level = 'error'
  and path like '/api/checkout%'
order by "timestamp" desc;
```

The audience this is built for: a team running Vercel plus Supabase, often
with a non-technical client or owner, where every extra vendor is a
liability the next maintainer inherits. This adds **zero new services** -
it reuses the Supabase project already in the stack.

## What this is not

Guardrails, stated up front:

- **No query UI or dashboard.** Use the Supabase SQL editor (or ask Claude
  to query it over the Supabase MCP).
- **No alerting or anomaly detection.**
- **No app-side correlation layer.** The logs carry Vercel's
  `request_id`, so you *can* join them to your own tables if you ever
  stamp that id onto your rows — but nothing here requires it, and there's
  no companion package to install.
- **No Iceberg / Analytics Buckets ingestion.** Writing Iceberg from Deno
  is not viable.
- **No OTLP trace drains.** Logs only.
- **No hosted or multi-tenant version.** This is a template you run
  yourself.
- **Not a general log aggregator.** It receives Vercel drains, nothing
  else.

## How it works

Two things you copy into your own Supabase project — a self-contained
edge function and the migrations it writes to:

| Piece | Runtime | How you use it |
| --- | --- | --- |
| [`supabase/functions/vercel-drain`](supabase/functions/vercel-drain) | Deno edge function | copy the folder, `supabase functions deploy` |
| [`supabase/migrations`](supabase/migrations) | Postgres | `supabase db push`, the way Supabase migrations work |

The function verifies each delivery's HMAC signature, parses the NDJSON
batch, normalizes it, and does one multi-row write over a direct Postgres
connection into a partitioned `drain.vercel_logs` table. That's the whole
pipeline. Everything the function needs lives in its own folder — nothing
to publish or install.

**[Setup guide →](docs/setup.md)** · **[Query recipes →](docs/queries.md)** · **[Cost notes →](docs/cost.md)**

Try it without deploying anything — `supabase start`, serve the function,
fire a signed fixture at it, and read the rows back out of Postgres:
[run it locally](docs/setup.md#part-1--run-it-locally). Note that Vercel
drains require a **Pro or Enterprise** team; the local path doesn't.

## Design decisions

### The handler returns 200 fast and does exactly one write

Edge functions have a ~2s CPU budget per request, and a drain batch can
carry several hundred to a thousand lines. Parse, normalize, one
multi-row write per sink. No per-row awaits, no enrichment calls, no
outbound HTTP.

### Unexposed `drain` schema, written over a direct connection

The table lives in a `drain` schema that is **not** in PostgREST's
exposed-schemas list, so it is unreachable through the REST API — no
anon, authenticated, or service role can touch it over HTTPS. The edge
function writes to it over a **direct Postgres connection** (postgres.js)
instead of supabase-js.

Two reasons this beats going through PostgREST:

1. **True isolation.** These are operational logs and can carry sensitive
   data (paths, the whole `proxy` object). Keeping the schema off the API
   surface means a leaked service-role key or a stray RLS policy can't
   expose them remotely.
2. **Ingestion doesn't depend on PostgREST.** If PostgREST is unhealthy
   (its schema cache can wedge — `PGRST002`), a PostgREST-based sink
   returns 500 and logs back up. A direct connection keeps writing —
   which is exactly when, during an incident, you most want logs landing.

The one hazard of direct connections from an edge function — "max client
connections reached" — is avoided by connecting through Supabase's
**transaction-mode pooler** (Supavisor), which is built for serverless.
The sink uses `prepare: false` (required by the pooler) and `max: 1`.
Reads are by humans over the SQL editor / a direct connection, so nothing
legitimate needs the REST API here.

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

A **DEFAULT partition** sits underneath as a safety net: if the cron job
lags or stops, rows for a not-yet-created day land there instead of
failing, so a dead cron degrades retention rather than breaking
ingestion.

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
| `SUPABASE_DB_URL` | auto | Injected by Supabase, and the sink's fallback — but it's the *direct* connection (port 5432), so relying on it exhausts `max_connections` under load. Prefer `DRAIN_DB_URL`. |
| `DRAIN_DB_URL` | **in practice, yes** | Supavisor transaction-pooler string (port 6543), from Dashboard → Connect. Takes precedence over `SUPABASE_DB_URL`. Set this on any real deployment — see [setup.md](docs/setup.md#3-point-the-sink-at-the-transaction-pooler) |
| `SUPABASE_URL` | archive only | Injected by Supabase; needed only when the Storage archive is enabled |
| `SUPABASE_SERVICE_ROLE_KEY` | archive only | Injected by Supabase; needed only when the Storage archive is enabled |
| `DRAIN_ARCHIVE_BUCKET` | no | Private Storage bucket; setting it enables the gzip archive sink |

Retention (default 14 days) is configured in SQL, where the cron job
lives — see `supabase/migrations/0003_retention_cron.sql`.

## Repo layout

```
supabase/
  functions/
    vercel-drain/     # the whole function — copy this folder and deploy
      index.ts        # entrypoint: Deno.serve(handlerFromEnv(...))
      handler.ts      # verify → parse → normalize → sinks
      verify.ts parse.ts normalize.ts schema.ts
      sinks/          # postgres (direct connection), storage (archive)
      deno.json       # import map
      tests/          # deno unit tests + fixtures
  migrations/         # partitioned table, maintenance, retention cron
  tests/              # SQL assertions, run against Postgres in CI
scripts/
  smoke.ts            # local end-to-end: signs a delivery, asserts 200/401
docs/
  setup.md  queries.md  cost.md
```

## Development

```sh
cd supabase/functions/vercel-drain && deno test --allow-read   # handler, parsing, signatures
# migrations: see supabase/tests/migrations_test.sql header
# local end-to-end (needs `supabase start` + the function served):
deno run --allow-read --allow-net --allow-env scripts/smoke.ts
```

`scripts/smoke.ts` fires a correctly-signed delivery at a running
function and asserts 200 + a bad signature gets 401 — the header comment
lists the two setup commands.

## License

[Apache 2.0](LICENSE), matching Supabase.
