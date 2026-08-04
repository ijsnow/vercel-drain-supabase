import { assertEquals } from "./asserts.ts";
import { normalizeBatch, normalizeEvent } from "../normalize.ts";
import { parseDrainBody } from "../parse.ts";

const fixture = (name: string): Promise<string> =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

Deno.test("normalizes a full lambda event", async () => {
  const { events } = parseDrainBody(await fixture("lambda.ndjson"));
  const row = normalizeEvent(events[0])!;
  assertEquals(row.id, "1723478400123456789");
  assertEquals(row.timestamp, new Date(1723478400123).toISOString());
  assertEquals(row.level, "info");
  assertEquals(row.source, "lambda");
  assertEquals(row.environment, "production");
  assertEquals(row.request_id, "dxb2k-1723478400100-8f3a21c9d4e0");
  assertEquals(row.status_code, 200);
  assertEquals(row.path, "/api/trpc/reservations.create");
  assertEquals(row.execution_region, "iad1");
  assertEquals(row.trace_id, "0af7651916cd43dd8448eb211c80319c");
  // The whole event, proxy included, is preserved in raw.
  assertEquals(
    (row.raw.proxy as { clientIp: string }).clientIp,
    "203.0.113.42",
  );
});

Deno.test("stderr events without a level become errors", async () => {
  const { events } = parseDrainBody(await fixture("lambda.ndjson"));
  const row = normalizeEvent(events[1])!;
  assertEquals(row.level, "error");
});

Deno.test("static events fall back to proxy path and status", async () => {
  const { events } = parseDrainBody(await fixture("lambda.ndjson"));
  const row = normalizeEvent(events[3])!;
  assertEquals(row.path, "/_next/static/chunks/main-4f2a1b.js");
  assertEquals(row.status_code, 200);
  assertEquals(row.level, null);
});

Deno.test("build events normalize without request fields", async () => {
  const { events } = parseDrainBody(await fixture("build.ndjson"));
  const row = normalizeEvent(events[0])!;
  assertEquals(row.source, "build");
  assertEquals(row.request_id, null);
  assertEquals(row.status_code, null);
  assertEquals(row.path, null);
});

Deno.test("events missing id or timestamp are rejected", () => {
  assertEquals(normalizeEvent({ message: "no key fields" }), null);
  assertEquals(normalizeEvent({ id: "a", timestamp: "not-a-number" }), null);
  assertEquals(normalizeEvent("not an object"), null);
  assertEquals(normalizeEvent(null), null);
});

Deno.test("numeric ids are coerced to strings", () => {
  const row = normalizeEvent({ id: 42, timestamp: 1723478400123 })!;
  assertEquals(row.id, "42");
});

Deno.test("normalizeBatch counts invalid events and dedupes rows", async () => {
  const { events } = parseDrainBody(await fixture("malformed.ndjson"));
  const duplicated = [...events, events[0]];
  const { rows, invalid } = normalizeBatch(duplicated);
  assertEquals(invalid, 1); // the {"message": ...} line with no id/timestamp
  assertEquals(rows.length, 2); // duplicate of the first event collapsed
});
