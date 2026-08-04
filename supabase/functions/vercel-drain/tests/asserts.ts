// Minimal assertion helpers over node:assert so the test suite has no
// registry dependencies at all.
import nodeAssert from "node:assert/strict";

export function assert(value: unknown, message?: string): void {
  nodeAssert.ok(value, message);
}

export function assertFalse(value: unknown, message?: string): void {
  nodeAssert.ok(!value, message);
}

export function assertEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  nodeAssert.deepEqual(actual, expected, message);
}
