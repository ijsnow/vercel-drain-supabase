import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correlationLine,
  getRequestId,
  logCorrelation,
  requestIdFromHeader,
} from "./index.ts";

test("requestIdFromHeader takes the final :: segment", () => {
  assert.equal(
    requestIdFromHeader("fra1::iad1::dxb2k-1723478400100-8f3a21c9d4e0"),
    "dxb2k-1723478400100-8f3a21c9d4e0",
  );
  assert.equal(
    requestIdFromHeader("dxb2k-1723478400100-8f3a21c9d4e0"),
    "dxb2k-1723478400100-8f3a21c9d4e0",
  );
});

test("requestIdFromHeader handles missing / empty values", () => {
  assert.equal(requestIdFromHeader(null), null);
  assert.equal(requestIdFromHeader(undefined), null);
  assert.equal(requestIdFromHeader(""), null);
  assert.equal(requestIdFromHeader("iad1::"), null);
});

test("getRequestId reads Fetch Headers", () => {
  const headers = new Headers({ "x-vercel-id": "iad1::abc-123" });
  assert.equal(getRequestId(headers), "abc-123");
});

test("getRequestId reads Node-style header records", () => {
  assert.equal(getRequestId({ "x-vercel-id": "iad1::abc-123" }), "abc-123");
  assert.equal(getRequestId({ "x-vercel-id": ["iad1::abc-123"] }), "abc-123");
  assert.equal(getRequestId({}), null);
});

test("correlationLine leads with the marker and request id", () => {
  const line = correlationLine("abc-123", { userId: "u1" });
  assert.ok(line.startsWith('{"vdc":1,"requestId":"abc-123"'));
  assert.deepEqual(JSON.parse(line), {
    vdc: 1,
    requestId: "abc-123",
    userId: "u1",
  });
});

test("logCorrelation writes exactly one line", () => {
  const lines: string[] = [];
  logCorrelation("abc-123", { userId: "u1" }, (l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).requestId, "abc-123");
});
