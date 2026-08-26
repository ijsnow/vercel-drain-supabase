# Cost notes

Prices are the published rates at the time of writing — check the linked
pages before trusting the arithmetic.

## What you pay

| Meter | Rate | Notes |
| --- | --- | --- |
| Vercel drain export | $0.50 / GB | Charged by Vercel for every GB the drain delivers, regardless of destination. You pay this with any drain vendor too. Billed on the *uncompressed* JSON serialization, so compressing in transit or at rest does not reduce it. |
| Supabase database disk | ~$0.125 / GB / month | Past the 8 GB included on Pro. This is the expensive place to keep logs. |
| Supabase file storage | ~$0.021 / GB / month | Roughly 6x cheaper than database disk, and the archive is gzipped on top of that. |

Sources: [Vercel drains pricing](https://vercel.com/docs/drains),
[Supabase pricing](https://supabase.com/pricing),
[Supabase storage pricing](https://supabase.com/docs/guides/storage/pricing).

## The shape this template assumes

- **Short retention in Postgres.** The default is 14 days of daily
  partitions. Hot logs are for incidents and the join queries in
  [queries.md](./queries.md); neither needs months of history online.
- **Long retention in Storage, optional.** The archive sink writes the
  raw deliveries as gzipped NDJSON. JSON logs compress well (5–10x is
  typical), so a GB of drain export becomes 100–200 MB of archive at
  ~$0.021/GB/month. When you need old logs, pull the day's objects and
  `gunzip | jq`, or bulk-reinsert them into a temporary table.

## Worked example

A modest production app emitting 5 GB of logs a month:

- Vercel export: 5 GB × $0.50 = **$2.50/month** (unavoidable with any drain)
- Postgres at 14-day retention: ~2.3 GB resident. Free if you are inside
  the 8 GB Pro allowance; ~$0.29/month past it.
- Archive (12 months, ~7x compression): ~8.6 GB × $0.021 ≈ **$0.18/month**.

The drain export fee dominates. Which leads to:

## Keep the bill down at the source

1. **Exclude the `static` source** in the drain configuration. Asset
   requests are high-volume and low-information; paying $0.50/GB to
   record cache hits on JS chunks is the classic mistake.
2. **Use drain sampling rules carefully**, or not at all. Rules match on
   environment plus an optional request path prefix — not on source or
   log level — and they are **deny-by-default**: once any rule exists,
   a request matching no rule is dropped entirely. So you cannot "sample
   `edge` but keep every `lambda` error"; you'd need a 100% rule for the
   paths you care about and a low-percentage rule for the noisy ones.
   With no rules at all, the drain forwards 100%
   ([docs](https://vercel.com/docs/drains/using-drains)).
3. **Tune retention to your incident-response window**, not to nostalgia.
   Fourteen days in Postgres plus a gzipped archive answers both "what is
   broken now" and "what happened in March" at close to the minimum
   possible price.
