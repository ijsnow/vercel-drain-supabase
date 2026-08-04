import { assert, assertEquals, assertFalse } from "./asserts.ts";
import { signBody, verifySignature } from "../verify.ts";

const SECRET = "test-drain-secret";

Deno.test("signBody produces a 40-char lowercase hex sha1 hmac", async () => {
  const sig = await signBody(SECRET, "hello");
  assertEquals(sig.length, 40);
  assert(/^[0-9a-f]{40}$/.test(sig));
});

Deno.test("known-answer: hmac-sha1 of empty body under empty-ish key", async () => {
  // Computed independently: HMAC-SHA1("key", "The quick brown fox jumps over the lazy dog")
  const sig = await signBody(
    "key",
    "The quick brown fox jumps over the lazy dog",
  );
  assertEquals(sig, "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
});

Deno.test("verifySignature accepts a correct signature", async () => {
  const body = '{"id":"1","timestamp":1723478400123}';
  const signature = await signBody(SECRET, body);
  assert(await verifySignature({ secret: SECRET, signature, body }));
});

Deno.test("verifySignature accepts uppercase and padded signatures", async () => {
  const body = "payload";
  const signature = (await signBody(SECRET, body)).toUpperCase();
  assert(
    await verifySignature({
      secret: SECRET,
      signature: ` ${signature} `,
      body,
    }),
  );
});

Deno.test("verifySignature rejects a tampered body", async () => {
  const signature = await signBody(SECRET, "original");
  assertFalse(
    await verifySignature({ secret: SECRET, signature, body: "tampered" }),
  );
});

Deno.test("verifySignature rejects the wrong secret", async () => {
  const body = "payload";
  const signature = await signBody("other-secret", body);
  assertFalse(await verifySignature({ secret: SECRET, signature, body }));
});

Deno.test("verifySignature rejects missing / malformed signatures", async () => {
  const body = "payload";
  assertFalse(await verifySignature({ secret: SECRET, signature: null, body }));
  assertFalse(await verifySignature({ secret: SECRET, signature: "", body }));
  assertFalse(
    await verifySignature({ secret: SECRET, signature: "deadbeef", body }),
  );
  assertFalse(
    await verifySignature({ secret: SECRET, signature: "z".repeat(40), body }),
  );
});
