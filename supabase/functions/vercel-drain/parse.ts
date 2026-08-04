/**
 * Body parsing for Vercel drain deliveries.
 *
 * Vercel log drains deliver either NDJSON (one JSON object per line,
 * `application/x-ndjson`) or a JSON array (`application/json`) depending
 * on how the drain was configured. Malformed lines are dropped and
 * counted rather than failing the whole delivery: a non-200 response
 * makes Vercel retry the entire batch, so one bad line must never poison
 * the hundreds of good ones around it.
 */

export interface ParseResult {
  /** Successfully parsed JSON values, in delivery order. */
  events: unknown[];
  /** Number of lines (or top-level values) that failed to parse. */
  malformed: number;
}

/**
 * Parse a drain delivery body. Accepts a JSON array, a single JSON
 * object, or NDJSON. Never throws.
 */
export function parseDrainBody(body: string): ParseResult {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { events: [], malformed: 0 };

  // JSON-array format. If the body starts with "[" but does not parse,
  // fall through to NDJSON handling rather than rejecting the batch.
  if (trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed);
      if (Array.isArray(value)) return { events: value, malformed: 0 };
      return { events: [value], malformed: 0 };
    } catch {
      // fall through
    }
  }

  const events: unknown[] = [];
  let malformed = 0;
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    try {
      events.push(JSON.parse(candidate));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}
