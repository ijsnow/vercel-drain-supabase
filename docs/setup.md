# Setup

End to end, this takes about fifteen minutes. You need a Supabase project
(free tier works), a Vercel project on a plan with drains, and the
[Supabase CLI](https://supabase.com/docs/guides/cli).

## 1. Apply the migrations

From a clone of this repo, linked to your project
(`supabase link --project-ref <ref>`):

```sh
supabase db push
```

This creates the `drain` schema, the partitioned `drain.vercel_logs`
table, the maintenance functions, and a daily pg_cron job that creates
tomorrow's partition and drops partitions older than 14 days. To change
retention, edit the number in `supabase/migrations/0003_retention_cron.sql`
and re-run the `cron.schedule` statement in the SQL editor — scheduling
under the same job name replaces the job.

The `drain` schema is intentionally **not** added to PostgREST's
exposed-schemas list, so the logs are unreachable through the REST API.
Don't add it. Ingestion uses a direct database connection
(`SUPABASE_DB_URL`, injected automatically), and you read the logs via the
SQL editor — neither needs the schema exposed. Make sure the `pg_cron`
extension is enabled (Dashboard → Database → Extensions); without it the
retention job never runs and the table grows forever.

## 2. Deploy the edge function

```sh
supabase functions deploy vercel-drain
```

`supabase/config.toml` in this repo already sets `verify_jwt = false` for
this function. **Do not skip this setting.** Vercel sends no Supabase
credentials, so with the platform JWT check on, every delivery bounces
with 401 and the drain never verifies. The endpoint is still
authenticated — by the drain's HMAC signature, inside the handler.

## 3. Create the drain in Vercel

In the Vercel dashboard: **Team Settings → Drains → Add Drain** (drains
can also be scoped to a single project — for docs see
<https://vercel.com/docs/drains>).

- **Type / sources**: Logs. Start with `lambda`, `edge`, `build`, and
  `firewall`. Leave `static` off unless you want to pay to ingest asset
  requests (see [cost.md](./cost.md)).
- **Format**: NDJSON (JSON array also works; the handler accepts both).
- **Endpoint**: `https://<project-ref>.supabase.co/functions/v1/vercel-drain`
- **Custom secret**: set one; this is your `VERCEL_DRAIN_SECRET`.

Vercel shows an `x-vercel-verify` code during creation. Copy it, then set
both secrets on the function **before** clicking verify:

```sh
supabase secrets set \
  VERCEL_DRAIN_SECRET=<the drain secret> \
  VERCEL_VERIFY_CODE=<the x-vercel-verify code>
```

Then complete verification in the Vercel dashboard. The handler attaches
`x-vercel-verify` to every response, so verification succeeds regardless
of method or body.

## 4. (Optional) enable the Storage archive

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

## 5. Check that data is flowing

Trigger some traffic, then in the Supabase SQL editor:

```sql
select "timestamp", source, level, status_code, path, request_id
from drain.vercel_logs
order by "timestamp" desc
limit 20;
```

That's it — logs are landing and retained. See [queries.md](./queries.md)
for incident-search recipes.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Drain verification fails | `VERCEL_VERIFY_CODE` not set, or function deployed with `verify_jwt` enabled |
| Every delivery is 401 with `invalid signature` | `VERCEL_DRAIN_SECRET` does not match the drain's custom secret |
| Every delivery is 401 and never reaches the function logs | `verify_jwt` still on — redeploy with this repo's `config.toml` |
| Deliveries are 500 with `sink write failed` | Check function logs; usually the migrations have not been applied, or a partition is missing (run `select drain.vercel_logs_maintenance(14)`) |
| Deliveries are 500 and logs mention a connection or auth error | The Postgres sink can't reach the database — check `SUPABASE_DB_URL`, or set `DRAIN_DB_URL` to the transaction-mode pooler string (port 6543) |
