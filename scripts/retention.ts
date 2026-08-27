// Inspect and change how many days of logs stay in drain.vercel_logs.
//
// Retention lives in the pg_cron job, not in an env var: the scheduled
// command passes retention_days to drain.vercel_logs_maintenance (see
// migrations/0003). Changing it is a one-line cron.schedule() call —
// what this script adds is a look at what that change will delete.
//
// Lowering retention destroys logs. The next maintenance run DROPs every
// partition past the cutoff, and unless DRAIN_ARCHIVE_BUCKET was set when
// those deliveries arrived, they are not recoverable. So the default is a
// dry run: it prints the partitions that would go and changes nothing.
//
// Usage:
//   export DRAIN_DB_URL='postgres://...pooler.supabase.com:6543/postgres'
//
//   deno run --allow-net --allow-env scripts/retention.ts
//       show the live schedule and every partition
//
//   deno run --allow-net --allow-env scripts/retention.ts 7
//       preview: what dropping to 7 days would delete
//
//   deno run --allow-net --allow-env scripts/retention.ts 7 --yes
//       reschedule the cron job to 7 days (takes effect at the next run)
//
//   deno run --allow-net --allow-env scripts/retention.ts 7 --yes --now
//       reschedule, then run maintenance immediately
//
// Note this only reschedules the job. Editing migrations/0003 does NOT
// change a project that already applied it, so the migration file and the
// live job can disagree; `scripts/retention.ts` with no arguments is the
// way to find out what is actually running.
import postgres from "postgres";

export const JOB_NAME = "vercel-logs-maintenance";
export const DEFAULT_SCHEDULE = "7 0 * * *";

/** Pull the retention_days argument back out of a scheduled command. */
export function parseRetention(command: string): number | null {
  const match = command.match(/retention_days\s*=>\s*(\d+)/) ??
    command.match(/vercel_logs_maintenance\s*\(\s*(\d+)\s*\)/);
  return match ? Number(match[1]) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

interface Partition {
  relname: string;
  day: string;
  bytes: number;
  est_rows: number;
  would_drop: boolean;
}

// deno-lint-ignore no-explicit-any
type Sql = any;

/**
 * Every daily partition, with whether the given retention would drop it.
 * The cutoff is computed in SQL against current_date so it matches
 * drain.vercel_logs_maintenance exactly rather than guessing at the
 * server's timezone.
 *
 * Two things the query is fussy about:
 *   * the `::int` cast — an untyped parameter makes Postgres resolve
 *     `current_date - $1` as date minus date, which yields an integer and
 *     fails with "operator does not exist: date < integer";
 *   * never interpolate into a SQL comment here — postgres.js would emit a
 *     placeholder the server cannot see, giving "could not determine data
 *     type of parameter $1".
 */
export async function inventory(
  sql: Sql,
  days: number,
): Promise<Partition[]> {
  return await sql`
    select c.relname,
           to_char(to_date(substring(c.relname from '\\d{8}$'), 'YYYYMMDD'), 'YYYY-MM-DD') as day,
           pg_total_relation_size(c.oid)::bigint as bytes,
           greatest(c.reltuples, 0)::bigint as est_rows,
           to_date(substring(c.relname from '\\d{8}$'), 'YYYYMMDD')
             < current_date - ${days}::int as would_drop
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace n on n.oid = c.relnamespace
    where i.inhparent = 'drain.vercel_logs'::regclass
      and n.nspname = 'drain'
      and c.relname ~ '^vercel_logs_p\\d{8}$'
    order by 2
  `;
}

async function main(): Promise<void> {
  const args = Deno.args;
  const apply = args.includes("--yes");
  const runNow = args.includes("--now");
  const positional = args.filter((a) => !a.startsWith("-"));

  if (positional.length > 1) {
    console.error("usage: retention.ts [days] [--yes] [--now]");
    Deno.exit(2);
  }
  const requested = positional.length === 1 ? Number(positional[0]) : null;
  if (requested !== null && (!Number.isInteger(requested) || requested < 1)) {
    console.error(
      `retention days must be a positive integer, got ${positional[0]}`,
    );
    Deno.exit(2);
  }

  const dbUrl = Deno.env.get("DRAIN_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    console.error("set DRAIN_DB_URL (or SUPABASE_DB_URL)");
    Deno.exit(2);
  }
  const sql = postgres(dbUrl, { prepare: false, max: 1 });

  try {
    const jobs = await sql`
      select schedule, command from cron.job where jobname = ${JOB_NAME}
    `.catch(() => []);
    const job = jobs[0];
    const live = job ? parseRetention(job.command) : null;

    if (job) {
      console.log(
        `live job "${JOB_NAME}": ${job.schedule}, retention ${
          live ?? "unknown"
        } day(s)`,
      );
    } else {
      console.log(
        `no "${JOB_NAME}" cron job found — pg_cron may be disabled, in which ` +
          `case nothing is creating or dropping partitions`,
      );
    }

    // With no target, report against what is live so the listing is honest.
    const target = requested ?? live ?? 14;
    const partitions = await inventory(sql, target);
    const doomed = partitions.filter((p) => p.would_drop);

    console.log(
      `\n${partitions.length} daily partition(s), ${
        formatBytes(partitions.reduce((sum, p) => sum + Number(p.bytes), 0))
      } total:\n`,
    );
    for (const p of partitions) {
      console.log(
        `  ${p.would_drop ? "DROP" : "keep"}  ${p.day}  ` +
          `${formatBytes(Number(p.bytes)).padStart(8)}  ~${p.est_rows} rows`,
      );
    }

    if (requested === null) {
      console.log(`\npass a number of days to preview a change.`);
      return;
    }

    const freed = doomed.reduce((sum, p) => sum + Number(p.bytes), 0);
    console.log(
      `\nretention ${live ?? "?"} -> ${target} day(s): ` +
        `${doomed.length} partition(s) would be dropped, freeing ${
          formatBytes(freed)
        }`,
    );

    if (!apply) {
      console.log(
        `\ndry run — nothing changed. Re-run with --yes to apply.` +
          (doomed.length > 0
            ? `\nThose logs are deleted permanently unless they were archived to Storage.`
            : ""),
      );
      return;
    }

    try {
      await sql`
        select cron.schedule(
          ${JOB_NAME},
          ${job?.schedule ?? DEFAULT_SCHEDULE},
          ${`select drain.vercel_logs_maintenance(retention_days => ${target})`}
        )
      `;
      console.log(`\nrescheduled "${JOB_NAME}" at ${target} day(s).`);
    } catch (error) {
      console.error(
        `\ncould not reschedule: ${
          error instanceof Error ? error.message : error
        }\n` +
          `Enable pg_cron (Dashboard -> Database -> Extensions) and retry. ` +
          `Nothing was changed.`,
      );
      Deno.exit(1);
    }

    if (runNow) {
      await sql`select drain.vercel_logs_maintenance(${target}::int)`;
      console.log(
        `ran maintenance now; ${doomed.length} partition(s) dropped.`,
      );
    } else {
      console.log(`takes effect at the next scheduled run.`);
    }

    console.log(
      `\nRemember migrations/0003 still says ${live ?? "?"} — update it so a ` +
        `fresh project matches.`,
    );
  } finally {
    await sql.end();
  }
}

if (import.meta.main) await main();
