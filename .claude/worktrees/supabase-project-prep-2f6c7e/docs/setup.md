# Setup

Two paths. Do them in order the first time:

1. **[Run it locally](#part-1--run-it-locally)** — ~5 minutes, no Vercel
   account, no deploy. Proves the pipeline works before you wire anything
   real to it.
2. **[Deploy it for real](#part-2--deploy-it-for-real)** — ~15 minutes,
   a Supabase project plus a Vercel drain.

## Requirements

| For | You need |
| --- | --- |
| Local run | [Supabase CLI](https://supabase.com/docs/guides/cli), Docker, [Deno](https://deno.com) |
| Real deploy | A Supabase project (free tier is fine) |
| Real deploy | A Vercel team on **Pro or Enterprise** |

> **Drains are not available on Hobby.** They are a Pro/Enterprise
> feature, billed at $0.50/GB of export
> ([pricing](https://vercel.com/docs/drains#usage-and-pricing)). If you
> are on Hobby, Part 1 still works — it exercises the entire handler and
> database path without Vercel.

---

# Part 1 — run it locally

No Vercel account, no deployed function, nothing to clean up afterwards.

## 1. Start the stack

From a clone of this repo:

```sh
supabase start
```

This boots local Postgres and applies the three migrations, so you get
the `drain` schema, the partitioned `drain.vercel_logs` table, the
maintenance functions, and the retention cron job.

## 2. Serve the function

```sh
printf 'VERCEL_DRAIN_SECRET=testsecret\n' > /tmp/drain.env
supabase functions serve vercel-drain --env-file /tmp/drain.env
```

`VERCEL_DRAIN_SECRET` is the only variable you have to supply. The CLI
injects `SUPABASE_DB_URL` for locally served functions, and the Postgres
sink picks it up automatically.

## 3. Fire a delivery at it

In a second terminal:

```sh
deno run --allow-read --allow-net --allow-env scripts/smoke.ts
```

This signs one of the NDJSON fixtures exactly the way Vercel would and
asserts both halves of the contract:

```
ok   signed   -> 200 {"received":4,"rows":4,"malformed":0}
ok   bad sig  -> 401 {"error":"invalid signature"}

smoke: all checks passed
```

## 4. Look at the rows

```sh
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c 'select "timestamp", source, level, status_code, path from drain.vercel_logs order by "timestamp" desc;'
```

or open the local Studio at <http://127.0.0.1:54323> and switch the
**schema** dropdown in the Table Editor from `public` to `drain`. Studio
talks to Postgres directly, so it browses the unexposed `drain` schema
the same way it browses `auth` and `storage` — it's the REST API that
can't reach it, not your own tooling.

Note that the Table Editor lists the partitions as separate tables
(`vercel_logs`, `vercel_logs_default`, `vercel_logs_p20260825`, …) and
opens an individual partition when you click one. Today's partition will
look empty after the smoke test; the fixture rows are in
`vercel_logs_default`. Query the parent `drain.vercel_logs` from the SQL
editor to see everything at once.

```
         timestamp          | source | level | status_code |               path
----------------------------+--------+-------+-------------+-------------------------------
 2024-08-12 16:00:02.423+00 | static |       |         200 | /_next/static/chunks/main-...
 2024-08-12 16:00:01.323+00 | edge   | info  |         200 | /dashboard
 2024-08-12 16:00:00.223+00 | lambda | error |         500 | /api/trpc/payments.charge
 2024-08-12 16:00:00.123+00 | lambda | info  |         200 | /api/trpc/reservations.create
```

The fixture timestamps are from 2024, so these rows land in
`drain.vercel_logs_default` rather than a daily partition — that is the
DEFAULT-partition safety net doing its job. Real deliveries carry current
timestamps and land in that day's partition. To confirm which partition
took a row:

```sql
select tableoid::regclass as partition, count(*)
from drain.vercel_logs group by 1;
```

Tear down with `supabase stop` when you're done.

---

# Part 2 — deploy it for real

## 1. Apply the migrations

Link the repo to your project and push:

```sh
supabase link --project-ref <ref>
supabase db push
```

The `drain` schema is intentionally **not** added to PostgREST's
exposed-schemas list, so the logs are unreachable through the REST API.
Don't add it. Ingestion uses a direct database connection
(`SUPABASE_DB_URL`, injected automatically), and you read the logs via
the SQL editor — neither needs the schema exposed.

Make sure the `pg_cron` extension is enabled (Dashboard → Database →
Extensions); without it the retention job never runs and the table grows
forever. To change retention from the default 14 days, edit the number in
`supabase/migrations/0003_retention_cron.sql` and re-run the
`cron.schedule` statement in the SQL editor — scheduling under the same
job name replaces the job.

## 2. Deploy the edge function

```sh
supabase functions deploy vercel-drain
```

`supabase/config.toml` in this repo already sets `verify_jwt = false` for
this function. **Do not skip this setting.** Vercel sends no Supabase
credentials, so with the platform JWT check on, every delivery bounces
with 401 before it ever reaches the handler. The endpoint is still
authenticated — by the drain's HMAC signature, checked inside the
handler.

Your endpoint URL is:

```
https://<project-ref>.supabase.co/functions/v1/vercel-drain
```

## 3. Point the sink at the transaction pooler

**Do this one — it is not optional in practice.** `SUPABASE_DB_URL`, the
variable Supabase injects and the sink falls back to, is the *direct*
connection string (`db.<ref>.supabase.co:5432`). Every edge isolate that
uses it opens a real Postgres connection, and Supabase runs many isolates
concurrently under drain load. On anything smaller than a large compute
instance you will exhaust `max_connections` and see this in the function
logs:

```
postgres sink: remaining connection slots are reserved for roles with the SUPERUSER attribute
```

A transaction-mode pooler (port 6543) exists for exactly this pattern —
many short-lived connections from serverless. Copy the string from
Dashboard → **Connect**; it offers two poolers, and they look different:

| | Shared Pooler (Supavisor) | Dedicated Pooler (PgBouncer) |
| --- | --- | --- |
| Host | `aws-0-<region>.pooler.supabase.com` | `db.<ref>.supabase.co` |
| User | `postgres.<ref>` | `postgres` |
| Tiers | all projects | paid plans only |
| Network | IPv4-only | IPv6 default, IPv4 with add-on |
| Tradeoff | multi-tenant | co-located, spends your project's compute |

**Default to the Shared Pooler**, especially on a small compute instance
— the dedicated one is co-located and consumes the same compute you're
already short on. Either way you want port **6543**, not 5432.

```sh
supabase secrets set DRAIN_DB_URL="postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
```

`DRAIN_DB_URL` takes precedence over `SUPABASE_DB_URL`. Transaction mode
doesn't support prepared statements, which is why the sink sets
`prepare: false`; it also sets `idle_timeout` so warm-but-idle isolates
release their connection instead of holding it.

## 4. Set the secret

Pick the secret now; you'll paste the same value into Vercel in step 5.
Any long random string works. **Print it before you set it** — Supabase
secrets are write-only, so once it's in there you cannot read it back:

```sh
SECRET=$(openssl rand -hex 32)
printf %s "$SECRET" | pbcopy    # straight to the clipboard, no trailing newline
supabase secrets set VERCEL_DRAIN_SECRET="$SECRET"
```

`printf %s` rather than `echo` on purpose: `echo` appends a newline, and a
trailing newline pasted into Vercel's secret field gives you a secret that
doesn't match and a 401 on every delivery. On Linux, swap `pbcopy` for
`xclip -selection clipboard` or `wl-copy`.

`supabase secrets list` shows only a SHA256 digest of each value, never
the value, and so does the dashboard. If you lose it, just generate and
set a new one — writing the same key again replaces it.

(The other direction works equally well: let Vercel auto-generate the
Signature Verification Secret in step 5, then copy it out and
`supabase secrets set VERCEL_DRAIN_SECRET=<that value>`. All that matters
is that the two sides match.)

Set it **before** creating the drain — Vercel tests the endpoint the
moment you click Create, and a function with no secret configured fails
to start.

## 5. Create the drain in Vercel

In the Vercel dashboard: **Team Settings → Drains → Add Drain**
([docs](https://vercel.com/docs/drains/using-drains)). Drains are
configured at the team level; you choose which projects feed them during
setup.

- **Data type**: Logs.
- **Projects**: all, or just the one you're testing with.
- **Sources**: start with `lambda`, `edge`, and `build`. Leave `static`
  off unless you want to pay to ingest asset requests — see
  [cost.md](./cost.md).
- **Sampling rules**: leave empty to forward 100%. Read the warning in
  [cost.md](./cost.md) before adding any — a request matching no rule is
  dropped.
- **Destination**: **Custom Endpoint**.
  - **Endpoint URL**: your function URL from step 2.
  - **Format**: NDJSON (JSON also works; the handler accepts both).
  - **Signature Verification Secret**: replace the auto-generated value
    with the secret from step 3, or copy the generated one and re-run
    `supabase secrets set` with it. These two must match.

Click **Create Drain**. Vercel tests the endpoint automatically on
creation, and there's a **Test** button on the drain afterwards for
re-checking. A passing test means signature verification and the database
write both worked.

## 6. Check that data is flowing

Trigger some traffic on the project, then in the Supabase SQL editor:

```sql
select "timestamp", source, level, status_code, path, request_id
from drain.vercel_logs
order by "timestamp" desc
limit 20;
```

That's it — logs are landing and retained. See [queries.md](./queries.md)
for incident-search recipes.

## Optional — the Storage archive

For retention beyond the Postgres window, archive every delivery as
gzipped NDJSON in Supabase Storage (~6x cheaper per GB than database
disk):

```sh
# Create a PRIVATE bucket named e.g. "vercel-drain-archive" in the
# dashboard or via the CLI, then:
supabase secrets set DRAIN_ARCHIVE_BUCKET=vercel-drain-archive
```

Objects land under `vercel-drain/<YYYY-MM-DD>/<sha256-of-body>.ndjson.gz`.
The key is derived from the body hash, so redelivered batches overwrite
rather than duplicate.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `supabase start` fails with "port is already allocated" | Another local stack or Postgres container holds 54321–54324. Stop it, or override the ports under `[api]` / `[db]` / `[studio]` in `supabase/config.toml`. |
| Vercel's endpoint test fails immediately | `VERCEL_DRAIN_SECRET` not set on the function, or the function was deployed with `verify_jwt` enabled |
| Every delivery is 401 with `invalid signature` | The function's `VERCEL_DRAIN_SECRET` doesn't match the drain's Signature Verification Secret |
| You lost track of the secret you set | Secrets are write-only — `supabase secrets list` shows only a digest. Generate a new one, `supabase secrets set` it, and update the drain's Signature Verification Secret to match. |
| Every delivery is 401 and nothing appears in the function logs | `verify_jwt` still on — redeploy with this repo's `config.toml` |
| Deliveries are 500 with `sink write failed` | Check function logs; usually the migrations haven't been applied, or a partition is missing (run `select drain.vercel_logs_maintenance(14)`) |
| Deliveries are 500 and logs mention a connection or auth error | The Postgres sink can't reach the database — check `SUPABASE_DB_URL`, or set `DRAIN_DB_URL` to the transaction-mode pooler string (port 6543) |
| Rows are piling up in `drain.vercel_logs_default` | The retention cron isn't creating daily partitions — check that `pg_cron` is enabled and the job exists in `cron.job` |

### Legacy drains

`VERCEL_VERIFY_CODE` supports the older Configurable/Integration Log
Drains API, which used an `x-vercel-verify` handshake header. The current
dashboard flow doesn't use it — leave the variable unset unless you're
creating a drain through the deprecated API, in which case set it to the
code Vercel gives you and the handler will echo it on every response.
