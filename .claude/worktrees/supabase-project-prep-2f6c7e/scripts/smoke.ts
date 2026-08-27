// Local end-to-end smoke test: fire a correctly-signed drain delivery at
// a running vercel-drain function, the way Vercel would, and assert the
// handler accepts it and rejects a bad signature. Exits non-zero on any
// unexpected result so it works in CI or a pre-deploy check.
//
// Prerequisites — a local stack with the function served and the secret set:
//
//   supabase start
//   printf 'VERCEL_DRAIN_SECRET=testsecret\n' > /tmp/drain.env
//   supabase functions serve vercel-drain --env-file /tmp/drain.env &
//
// Then:
//
//   deno run --allow-read --allow-net --allow-env scripts/smoke.ts
//
// Override the target/secret via env when pointing at a deployed function:
//   DRAIN_URL=https://<ref>.supabase.co/functions/v1/vercel-drain \
//   VERCEL_DRAIN_SECRET=<real secret> deno run ... scripts/smoke.ts
import { signBody } from "../supabase/functions/vercel-drain/verify.ts";

const secret = Deno.env.get("VERCEL_DRAIN_SECRET") ?? "testsecret";
const url = Deno.env.get("DRAIN_URL") ??
  "http://127.0.0.1:54321/functions/v1/vercel-drain";
const fixture = new URL(
  "../supabase/functions/vercel-drain/tests/fixtures/lambda.ndjson",
  import.meta.url,
);
const body = await Deno.readTextFile(fixture);

const headers = (sig: string) => ({
  "x-vercel-signature": sig,
  "content-type": "application/x-ndjson",
});

let failures = 0;
const expect = (label: string, actual: number, want: number, extra = "") => {
  const ok = actual === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label} -> ${actual} ${extra}`);
};

// 1. Correctly signed → 200.
const sig = await signBody(secret, body);
const good = await fetch(url, { method: "POST", headers: headers(sig), body });
expect("signed  ", good.status, 200, await good.text());

// 2. Wrong signature → 401, nothing written.
const bad = await fetch(url, {
  method: "POST",
  headers: headers("deadbeef"),
  body,
});
expect("bad sig ", bad.status, 401, await bad.text());

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  Deno.exit(1);
}
console.log("\nsmoke: all checks passed");
