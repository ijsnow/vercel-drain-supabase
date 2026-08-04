/**
 * Signature verification for Vercel drain deliveries.
 *
 * Vercel signs every drain request body with HMAC-SHA1 using the drain
 * secret and sends the hex digest in the `x-vercel-signature` header.
 * During drain creation Vercel also expects the endpoint to echo a
 * verification code back in the `x-vercel-verify` response header.
 */

/** Request header carrying the hex HMAC-SHA1 digest of the raw body. */
export const SIGNATURE_HEADER = "x-vercel-signature";

/** Response header Vercel checks during the drain verification handshake. */
export const VERIFY_HEADER = "x-vercel-verify";

const encoder = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
}

/**
 * Compute the hex HMAC-SHA1 digest of `body` with `secret`, exactly as
 * Vercel computes the `x-vercel-signature` header.
 */
export async function signBody(
  secret: string,
  body: string | Uint8Array,
): Promise<string> {
  const key = await importHmacKey(secret);
  const data = typeof body === "string" ? encoder.encode(body) : body;
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    data as unknown as ArrayBuffer,
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time byte comparison. The length check is not constant time,
 * but the digest length is public information (SHA-1 is always 40 hex
 * characters), so it leaks nothing.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify a drain delivery signature. Returns `true` only when `signature`
 * is the hex HMAC-SHA1 of `body` under `secret`. Comparison is
 * timing-safe.
 */
export async function verifySignature(options: {
  secret: string;
  signature: string | null | undefined;
  body: string | Uint8Array;
}): Promise<boolean> {
  const { secret, signature, body } = options;
  if (!signature) return false;
  const expected = await signBody(secret, body);
  return timingSafeEqual(
    encoder.encode(expected),
    encoder.encode(signature.trim().toLowerCase()),
  );
}
