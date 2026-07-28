/**
 * Postgres sink, via supabase-js and PostgREST.
 *
 * Going through PostgREST with the service role key means connection
 * pooling never becomes the operator's problem, and idempotency is one
 * call: an upsert on the `(timestamp, id)` primary key with
 * `ignoreDuplicates` compiles to `INSERT ... ON CONFLICT DO NOTHING`,
 * which makes at-least-once delivery safe.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DrainBatch, Sink } from "../mod.ts";

export interface PostgresSinkOptions {
  /** Supabase project URL, e.g. https://abc.supabase.co */
  url: string;
  /** Service role key. Never the anon key: RLS blocks anon inserts. */
  serviceRoleKey: string;
  /** Target table. Defaults to `vercel_logs`. */
  table?: string;
  /** Bring your own client (used in tests). */
  client?: SupabaseClient;
}

export function postgresSink(options: PostgresSinkOptions): Sink {
  const table = options.table ?? "vercel_logs";
  const client = options.client ??
    createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false },
    });

  return {
    name: "postgres",
    async write(batch: DrainBatch): Promise<void> {
      if (batch.rows.length === 0) return;
      const { error } = await client.from(table).upsert(batch.rows, {
        onConflict: "timestamp,id",
        ignoreDuplicates: true,
      });
      if (error) {
        // Throwing turns into a 500 from the handler, and a 500 makes
        // Vercel redeliver the batch. Idempotency makes that safe.
        throw new Error(`postgres sink: ${error.message}`);
      }
    },
  };
}
