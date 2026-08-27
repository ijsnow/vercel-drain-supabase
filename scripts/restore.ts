// Restore archived drain deliveries from Supabase Storage back into a
// queryable table — without touching the live ingestion path.
//
// The archive holds one gzipped object per delivery, keyed by body hash
// (see functions/vercel-drain/sinks/storage.ts). This script lists a day's
// objects, gunzips them, runs them back through the same parse/normalize
// modules the edge function uses, and inserts the rows into a SEPARATE
// restore table.
//
// Why a separate table, and not drain.vercel_logs:
//   * That day's partition has been dropped, so old rows would fall into
//     drain.vercel_logs_default.
//   * The retention job only drops partitions matching ^vercel_logs_p\d{8}$
//     (migrations/0002), so anything landing in _default is never reclaimed.
//   * The restore table is not a partition of drain.vercel_logs at all, so
//     the maintenance function cannot see it. Drop it yourself when done.
//
// Usage:
//   export DRAIN_ARCHIVE_BUCKET=vercel-drain-archive
//   export SUPABASE_URL=https://<ref>.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=<service role key>
//   export DRAIN_DB_URL='postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres'
//   deno run --allow-net --allow-env scripts/restore.ts 2026-03-03 [2026-03-04 ...]
//
// Then query it with the recipes in docs/queries.md — the columns are
// identical to drain.vercel_logs — and clean up with:
//   drop table drain.vercel_logs_restore;
//
// Note on day boundaries: an object is filed under the day of the FIRST
// event in its batch, so a delivery spanning midnight lands entirely in the
// earlier day. To cover day D exhaustively, restore D-1 as well and filter
// on "timestamp" when you query.
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { parseDrainBody } from "../supabase/functions/vercel-drain/parse.ts";
import { normalizeBatch } from "../supabase/functions/vercel-drain/normalize.ts";
import { postgresSink } from "../supabase/functions/vercel-drain/sinks/postgres.ts";

const env = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
};

/** A restore table name is interpolated into DDL, so keep it plain. */
export const VALID_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
export const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Mirror of the gzip in sinks/storage.ts. */
export async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/**
 * Run `fn` over `items` with at most `size` in flight. Thousands of small
 * objects is the normal case, so the whole list must not be awaited at once.
 */
export async function pool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

// deno-lint-ignore no-explicit-any
type Storage = any;

/**
 * List every archived object for a day. storage.list() pages at 100 by
 * default and caps at 1000, so this has to loop — without it you silently
 * restore only the first page and believe you are done.
 */
export async function listDay(
  storage: Storage,
  prefix: string,
  day: string,
): Promise<string[]> {
  const folder = `${prefix}/${day}`;
  const limit = 1000;
  const keys: string[] = [];
  for (let offset = 0;; offset += limit) {
    const { data, error } = await storage.list(folder, { limit, offset });
    if (error) throw new Error(`storage list ${folder}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const object of data) {
      if (object.name.endsWith(".ndjson.gz")) {
        keys.push(`${folder}/${object.name}`);
      }
    }
    if (data.length < limit) break;
  }
  return keys;
}

async function main(): Promise<void> {
  const days = Deno.args.filter((a) => !a.startsWith("-"));
  if (days.length === 0) {
    console.error(
      "usage: deno run --allow-net --allow-env scripts/restore.ts <YYYY-MM-DD> [...]",
    );
    Deno.exit(2);
  }
  for (const day of days) {
    if (!VALID_DAY.test(day)) {
      console.error(`not a YYYY-MM-DD day: ${day}`);
      Deno.exit(2);
    }
  }

  const bucket = env("DRAIN_ARCHIVE_BUCKET");
  const dbUrl = Deno.env.get("DRAIN_DB_URL") ?? env("SUPABASE_DB_URL");
  const prefix = Deno.env.get("DRAIN_ARCHIVE_PREFIX") ?? "vercel-drain";
  const table = Deno.env.get("DRAIN_RESTORE_TABLE") ??
    "drain.vercel_logs_restore";
  if (!VALID_TABLE.test(table)) {
    console.error(
      `DRAIN_RESTORE_TABLE must be a simple schema.table: ${table}`,
    );
    Deno.exit(2);
  }

  const supabase = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
  const storage = supabase.storage.from(bucket);

  const sql = postgres(dbUrl, { prepare: false, max: 4 });
  // LIKE ... INCLUDING ALL copies the columns, the (timestamp, id) primary
  // key the sink's ON CONFLICT needs, and both indexes. RLS is not copied by
  // LIKE, so enable it explicitly to match drain.vercel_logs (0001).
  await sql.unsafe(
    `create table if not exists ${table} (like drain.vercel_logs including all)`,
  );
  await sql.unsafe(`alter table ${table} enable row level security`);

  // Reuse the ingest sink, pointed at the restore table, so the multi-row
  // insert and idempotent ON CONFLICT come for free.
  const sink = postgresSink({ connectionString: dbUrl, client: sql, table });

  let objects = 0, rows = 0, malformed = 0, failed = 0;

  for (const day of days) {
    const keys = await listDay(storage, prefix, day);
    console.log(`${day}: ${keys.length} object(s)`);

    await pool(keys, 8, async (key) => {
      try {
        const { data, error } = await storage.download(key);
        if (error) throw new Error(error.message);
        const body = await gunzip(data as Blob);
        const parsed = parseDrainBody(body);
        const { rows: batchRows, invalid } = normalizeBatch(parsed.events);
        if (batchRows.length > 0) {
          await sink.write({
            rows: batchRows,
            body,
            received: parsed.events.length,
            malformed: parsed.malformed + invalid,
          });
        }
        objects++;
        rows += batchRows.length;
        malformed += parsed.malformed + invalid;
      } catch (error) {
        failed++;
        console.error(
          `  failed ${key}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });
  }

  await sql.end();

  console.log(
    `\nrestored ${rows} row(s) from ${objects} object(s) into ${table}` +
      (malformed > 0 ? ` (${malformed} malformed event(s) skipped)` : "") +
      (failed > 0 ? `, ${failed} object(s) failed` : ""),
  );
  console.log(`\n  select * from ${table} order by "timestamp" desc limit 20;`);
  console.log(`  drop table ${table};   -- when you are done\n`);

  if (failed > 0) Deno.exit(1);
}

if (import.meta.main) await main();
