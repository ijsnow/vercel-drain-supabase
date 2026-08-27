/**
 * Vercel log drain handler for Supabase edge functions.
 *
 * Receives signed NDJSON deliveries from a Vercel drain, verifies the
 * HMAC-SHA1 signature, parses and normalizes the batch, and hands it to
 * one or more sinks (Postgres, optional Storage archive). Designed for
 * the edge function CPU budget: parse, normalize, one multi-row write
 * per sink. No per-row awaits, no enrichment, no outbound HTTP beyond
 * the sink writes themselves.
 *
 * `index.ts` wires this to the runtime:
 *
 * ```ts
 * import { handlerFromEnv } from "./handler.ts";
 * Deno.serve(handlerFromEnv(Deno.env.toObject()));
 * ```
 */
import { SIGNATURE_HEADER, VERIFY_HEADER, verifySignature } from "./verify.ts";
import { parseDrainBody } from "./parse.ts";
import { type LogRow, normalizeBatch } from "./normalize.ts";
import { postgresSink } from "./sinks/postgres.ts";
import { storageSink } from "./sinks/storage.ts";

/** One delivery, after parsing and normalization. */
export interface DrainBatch {
  /** Normalized rows, deduplicated on `(timestamp, id)`. */
  rows: LogRow[];
  /** The raw request body, for archival sinks. */
  body: string;
  /** Count of parsed JSON values before normalization. */
  received: number;
  /** Lines that failed JSON parsing plus events missing id/timestamp. */
  malformed: number;
}

/** A destination for drain batches. Throw to make Vercel redeliver. */
export interface Sink {
  name: string;
  write(batch: DrainBatch): Promise<void>;
}

/** Per-delivery summary, returned in the response body and logged. */
export interface BatchSummary {
  received: number;
  rows: number;
  malformed: number;
}

export interface DrainHandlerOptions {
  /** HMAC secret from the Vercel drain configuration. Required. */
  secret: string;
  /** `x-vercel-verify` code. Attached to every response when set. */
  verifyCode?: string;
  /** Where batches go. Usually `[postgresSink(...)]`. */
  sinks: Sink[];
  /**
   * Called once per delivery with the batch summary. Defaults to one
   * `console.info` JSON line so malformed-line counts are visible in
   * the function logs without failing the delivery.
   */
  onBatch?: (summary: BatchSummary) => void;
}

function json(
  status: number,
  body: Record<string, unknown>,
  headers: Headers,
): Response {
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Build the request handler. The returned function is directly
 * compatible with `Deno.serve`.
 */
export function createDrainHandler(
  options: DrainHandlerOptions,
): (request: Request) => Promise<Response> {
  if (!options.secret) {
    throw new Error(
      "createDrainHandler: `secret` is required (VERCEL_DRAIN_SECRET). " +
        "The endpoint is public — verify_jwt is off — so the drain " +
        "signature is the only authentication.",
    );
  }
  const onBatch = options.onBatch ??
    ((summary: BatchSummary) =>
      console.info(JSON.stringify({ drain: "batch", ...summary })));

  return async (request: Request): Promise<Response> => {
    // The verification handshake: Vercel checks for this header when
    // the drain is created. Attach it to every response, success or
    // error, so setup never fails confusingly.
    const headers = new Headers();
    if (options.verifyCode) headers.set(VERIFY_HEADER, options.verifyCode);

    if (request.method === "GET" || request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" }, headers);
    }

    const body = await request.text();
    const signature = request.headers.get(SIGNATURE_HEADER);
    const verified = await verifySignature({
      secret: options.secret,
      signature,
      body,
    });
    if (!verified) {
      return json(401, { error: "invalid signature" }, headers);
    }

    const parsed = parseDrainBody(body);
    const { rows, invalid } = normalizeBatch(parsed.events);
    const summary: BatchSummary = {
      received: parsed.events.length,
      rows: rows.length,
      malformed: parsed.malformed + invalid,
    };

    if (rows.length > 0) {
      const batch: DrainBatch = {
        rows,
        body,
        received: summary.received,
        malformed: summary.malformed,
      };
      try {
        await Promise.all(options.sinks.map((sink) => sink.write(batch)));
      } catch (error) {
        // Non-200 → Vercel redelivers the whole batch. Safe, because
        // every sink write is idempotent.
        console.error(
          JSON.stringify({
            drain: "sink_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return json(500, { error: "sink write failed" }, headers);
      }
    }

    onBatch(summary);
    return json(200, summary as unknown as Record<string, unknown>, headers);
  };
}

/**
 * Build a handler from environment variables:
 *
 * - `VERCEL_DRAIN_SECRET` (required) — HMAC secret from the drain config
 * - `VERCEL_VERIFY_CODE` — `x-vercel-verify` value
 * - `SUPABASE_DB_URL` (required) — Postgres connection string, injected
 *   automatically on Supabase. Override with `DRAIN_DB_URL` (e.g. to force
 *   the transaction-mode pooler). The Postgres sink writes over this.
 * - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — only required when
 *   `DRAIN_ARCHIVE_BUCKET` is set; the Storage archive still goes through
 *   the Storage API, not the direct connection.
 * - `DRAIN_ARCHIVE_BUCKET` — optional, enables the Storage archive sink
 */
export function handlerFromEnv(
  env: Record<string, string | undefined>,
): (request: Request) => Promise<Response> {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };

  const connectionString = env.DRAIN_DB_URL ?? need("SUPABASE_DB_URL");
  const sinks: Sink[] = [postgresSink({ connectionString })];
  if (env.DRAIN_ARCHIVE_BUCKET) {
    sinks.push(
      storageSink({
        url: need("SUPABASE_URL"),
        serviceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),
        bucket: env.DRAIN_ARCHIVE_BUCKET,
      }),
    );
  }

  return createDrainHandler({
    secret: need("VERCEL_DRAIN_SECRET"),
    verifyCode: env.VERCEL_VERIFY_CODE,
    sinks,
  });
}
