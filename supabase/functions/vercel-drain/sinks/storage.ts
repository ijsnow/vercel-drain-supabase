/**
 * Optional archive sink: gzip the raw delivery body into Supabase
 * Storage. Storage is ~6x cheaper per GB than database disk, so this is
 * the long-retention half of the design — short retention in Postgres,
 * gzipped NDJSON in a bucket for anything older.
 *
 * The object key is derived from a SHA-256 of the body, so a retried
 * delivery overwrites the same object instead of duplicating it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DrainBatch, Sink } from "../handler.ts";

export interface StorageSinkOptions {
  /** Supabase project URL. */
  url: string;
  /** Service role key. */
  serviceRoleKey: string;
  /** Bucket name. Must already exist; create it private. */
  bucket: string;
  /** Key prefix inside the bucket. Defaults to `vercel-drain`. */
  prefix?: string;
  /** Bring your own client (used in tests). */
  client?: SupabaseClient;
}

async function gzip(text: string): Promise<Uint8Array> {
  const compressed = new Blob([text]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function storageSink(options: StorageSinkOptions): Sink {
  const prefix = options.prefix ?? "vercel-drain";
  const client = options.client ??
    createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false },
    });

  return {
    name: "storage",
    async write(batch: DrainBatch): Promise<void> {
      if (batch.rows.length === 0) return;
      // Partition object keys by the day of the first event so pruning
      // the archive is a prefix listing, mirroring the table partitions.
      const day = batch.rows[0].timestamp.slice(0, 10);
      const hash = await sha256Hex(batch.body);
      const key = `${prefix}/${day}/${hash}.ndjson.gz`;
      const compressed = await gzip(batch.body);
      const { error } = await client.storage
        .from(options.bucket)
        .upload(key, compressed as unknown as ArrayBuffer, {
          contentType: "application/gzip",
          upsert: true,
        });
      if (error) {
        throw new Error(`storage sink: ${error.message}`);
      }
    },
  };
}
