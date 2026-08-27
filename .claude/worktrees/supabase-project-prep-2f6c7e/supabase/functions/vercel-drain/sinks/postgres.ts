/**
 * Postgres sink, via a direct connection (postgres.js) to the transaction
 * pooler.
 *
 * The table lives in the `drain` schema, which is NOT exposed through
 * PostgREST, so it cannot be reached over the REST API — and, just as
 * important, ingestion does not depend on PostgREST being healthy. We
 * connect straight to Postgres through Supabase's transaction-mode pooler
 * (Supavisor), which is built for serverless/edge and keeps connection
 * counts bounded, so this does not reintroduce the "max client
 * connections reached" failure that rules out raw 5432 connections.
 *
 * Idempotency is an upsert on the `(timestamp, id)` primary key with
 * `on conflict do nothing`, which makes at-least-once delivery safe.
 */
import postgres from "postgres";
import type { DrainBatch, Sink } from "../handler.ts";

// deno-lint-ignore no-explicit-any
type Sql = any;

export interface PostgresSinkOptions {
  /**
   * Postgres connection string. Use the transaction-mode pooler
   * (Supavisor, port 6543). On Supabase this is injected as
   * `SUPABASE_DB_URL`.
   */
  connectionString: string;
  /** Target table. Defaults to `drain.vercel_logs`. */
  table?: string;
  /** Bring your own postgres.js client (used in tests). */
  client?: Sql;
}

const COLUMNS = [
  "id",
  "timestamp",
  "level",
  "source",
  "environment",
  "request_id",
  "status_code",
  "path",
  "execution_region",
  "trace_id",
  "message",
  "raw",
] as const;

export function postgresSink(options: PostgresSinkOptions): Sink {
  const [schema, table] = (options.table ?? "drain.vercel_logs").split(".");
  // ponytail: max 1 connection per worker — a log drain is not latency
  // critical, and keeping it at 1 is the conservative choice against
  // connection exhaustion. Raise `max` if write throughput ever matters.
  // `prepare: false` is required by the transaction-mode pooler.
  //
  // idle_timeout matters more than it looks: edge isolates are recycled
  // unpredictably, and without it every warm-but-idle isolate holds its
  // connection open. On a small compute instance that exhausts
  // max_connections ("remaining connection slots are reserved...") even
  // at modest delivery rates. 20s is well under any pooler idle reaper.
  const sql: Sql = options.client ??
    postgres(options.connectionString, {
      prepare: false,
      max: 1,
      idle_timeout: 20,
    });

  return {
    name: "postgres",
    async write(batch: DrainBatch): Promise<void> {
      if (batch.rows.length === 0) return;
      // postgres.js encodes plain objects into jsonb, so `raw` goes in as
      // an object. The (schema, table) identifiers are interpolated with
      // sql() so they are quoted, not string-concatenated.
      try {
        await sql`
          insert into ${sql(schema)}.${sql(table)} ${
          sql(batch.rows, ...COLUMNS)
        }
          on conflict ("timestamp", id) do nothing
        `;
      } catch (error) {
        // Throwing turns into a 500 from the handler, and a 500 makes
        // Vercel redeliver the batch. Idempotency makes that safe.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`postgres sink: ${message}`);
      }
    },
  };
}
