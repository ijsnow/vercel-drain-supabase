/**
 * Framework-agnostic correlation helper. Works with anything that can
 * hand you request headers: route handlers, middleware, API routes.
 *
 * ```ts
 * import { correlate } from "vercel-drain-correlate/http";
 *
 * export async function POST(request: Request) {
 *   const c = correlate(request.headers);
 *   c.annotate({ userId: session.userId, route: "checkout" });
 *   await db.insert(payments).values(c.stamp({ amount, userId }));
 *   // ...
 * }
 * ```
 */
import {
  getRequestId,
  type HeadersLike,
  type Identity,
  logCorrelation,
} from "./index.ts";

export interface Correlation {
  /** Vercel's request id, or `null` outside Vercel. */
  readonly requestId: string | null;
  /**
   * Emit a correlation line tying this request to the given identity.
   * Call it once per request with everything you know; calling again
   * with more context is fine — the drain keeps every line.
   */
  annotate(identity: Identity): void;
  /** Return `row` with `request_id` added, for stamping database writes. */
  stamp<T extends object>(row: T): T & { request_id: string | null };
}

export interface CorrelateOptions {
  /** Custom line writer; defaults to `console.log` (stdout → drain). */
  write?: (line: string) => void;
}

/** Create a {@link Correlation} for one request. */
export function correlate(
  headers: HeadersLike,
  options: CorrelateOptions = {},
): Correlation {
  const requestId = getRequestId(headers);
  return {
    requestId,
    annotate(identity: Identity): void {
      logCorrelation(requestId, identity, options.write);
    },
    stamp<T extends object>(row: T): T & { request_id: string | null } {
      return { ...row, request_id: requestId };
    },
  };
}
