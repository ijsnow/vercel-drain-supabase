import { test } from "node:test";
import assert from "node:assert/strict";
import { correlate } from "./http.ts";

test("correlate extracts the request id and stamps rows", () => {
  const c = correlate(new Headers({ "x-vercel-id": "iad1::abc-123" }));
  assert.equal(c.requestId, "abc-123");
  assert.deepEqual(c.stamp({ amount: 100 }), {
    amount: 100,
    request_id: "abc-123",
  });
});

test("annotate emits a marker line with identity", () => {
  const lines: string[] = [];
  const c = correlate(
    { "x-vercel-id": "iad1::abc-123" },
    { write: (l) => lines.push(l) },
  );
  c.annotate({ userId: "u1", route: "checkout" });
  assert.deepEqual(JSON.parse(lines[0]), {
    vdc: 1,
    requestId: "abc-123",
    userId: "u1",
    route: "checkout",
  });
});

test("outside Vercel everything degrades to null, nothing throws", () => {
  const c = correlate({});
  assert.equal(c.requestId, null);
  assert.deepEqual(c.stamp({ a: 1 }), { a: 1, request_id: null });
  const lines: string[] = [];
  correlate({}, { write: (l) => lines.push(l) }).annotate({ userId: "u1" });
  assert.equal(JSON.parse(lines[0]).requestId, null);
});
