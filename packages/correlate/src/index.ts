/**
 * Correlation helpers for vercel-drain-supabase.
 *
 * The correlation loop:
 *
 * 1. Your app emits one structured line per request containing the
 *    Vercel request id plus whatever domain identity it knows
 *    ({@link logCorrelation}).
 * 2. That line arrives back through the drain and lands in the
 *    `vercel_logs` table.
 * 3. Your app also stamps `request_id` onto rows it writes.
 * 4. Queries join the two on `request_id`.
 *
 * The join key is Vercel's own request id, taken from the `x-vercel-id`
 * request header — the same id every drain log row carries in its
 * `requestId` field — rather than an id we generate, so the join works
 * for every log line of the request, not only the ones your code wrote.
 */

/** Request header Vercel adds to every request reaching your app. */
export const REQUEST_ID_HEADER = "x-vercel-id";

/**
 * Marker key for correlation lines. `JSON.stringify` preserves insertion
 * order and this key is always written first, so drain rows produced by
 * this package are matchable in SQL with `message like '{"vdc":1%'`.
 */
export const MARKER_KEY = "vdc";

/** Domain identity attached to a correlation line. Keep it terse. */
export type Identity = Record<string, unknown>;

/** Anything header-shaped: Fetch `Headers`, or a Node header object. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

/**
 * Extract the request id from an `x-vercel-id` header value.
 *
 * The header value lists the regions the request passed through, ending
 * with the id, e.g. `fra1::iad1::dxb2k-1723478400100-8f3a21c9d4e0`. The
 * final segment is the `requestId` that appears in drain log events.
 */
export function requestIdFromHeader(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const segments = value.split("::");
  const id = segments[segments.length - 1]?.trim();
  return id ? id : null;
}

function readHeader(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Read the Vercel request id from request headers. Returns `null`
 * outside Vercel (local dev), in which case correlation is a no-op —
 * never a crash.
 */
export function getRequestId(headers: HeadersLike): string | null {
  return requestIdFromHeader(readHeader(headers, REQUEST_ID_HEADER));
}

/**
 * Build the correlation line: compact JSON with the marker first, then
 * the request id, then the identity fields.
 */
export function correlationLine(
  requestId: string | null,
  identity: Identity = {},
): string {
  return JSON.stringify({ [MARKER_KEY]: 1, requestId, ...identity });
}

/**
 * Emit a correlation line to stdout (or a custom writer). On Vercel,
 * stdout is exactly what the log drain forwards.
 */
export function logCorrelation(
  requestId: string | null,
  identity: Identity = {},
  write: (line: string) => void = console.log,
): void {
  write(correlationLine(requestId, identity));
}
