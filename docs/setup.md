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

This creates the partitioned `vercel_logs` table, the maintenance
functions, and a daily pg_cron job that creates tomorrow's partition and
drops partitions older than 14 days. To change retention, edit the number
in `supabase/migrations/0003_retention_cron.sql` and re-run the
`cron.schedule` statement in the SQL editor — scheduling under the same
job name replaces the job.

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

## 5. Wire the correlation loop

Ingesting logs is half the value; the joins in
[queries.md](./queries.md) need your app to participate. Install the
companion package in your Vercel app:

```sh
npm install vercel-drain-correlate
```

Then (tRPC example — see `examples/tanstack-start-trpc/`):

```ts
import { correlateMiddleware } from "vercel-drain-correlate/trpc";

const correlated = t.procedure.use(t.middleware(correlateMiddleware({
  getHeaders: (ctx) => ctx.headers,
  getIdentity: (ctx) => ({ userId: ctx.session?.userId ?? null }),
})));
```

and stamp `request_id` onto rows you write:

```ts
await db.insert(payments).values({ ...payment, request_id: ctx.requestId });
```

## 6. Check that data is flowing

Trigger some traffic, then in the Supabase SQL editor:

```sql
select "timestamp", source, level, status_code, path, request_id
from vercel_logs
order by "timestamp" desc
limit 20;
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Drain verification fails | `VERCEL_VERIFY_CODE` not set, or function deployed with `verify_jwt` enabled |
| Every delivery is 401 with `invalid signature` | `VERCEL_DRAIN_SECRET` does not match the drain's custom secret |
| Every delivery is 401 and never reaches the function logs | `verify_jwt` still on — redeploy with this repo's `config.toml` |
| Deliveries are 500 with `sink write failed` | Check function logs; usually the migrations have not been applied, or a partition is missing (run `select vercel_logs_maintenance(14)`) |
| Rows appear but `request_id` joins find nothing | The correlate loop is not wired; see step 5 |
