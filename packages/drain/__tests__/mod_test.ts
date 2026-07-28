import { assert, assertEquals } from "./asserts.ts";
import {
  createDrainHandler,
  type DrainBatch,
  type Sink,
  VERIFY_HEADER,
} from "../mod.ts";
import { signBody } from "../verify.ts";

const SECRET = "test-drain-secret";
const VERIFY_CODE = "verify-code-1234";

function collectingSink(): Sink & { batches: DrainBatch[] } {
  const batches: DrainBatch[] = [];
  return {
    name: "collect",
    batches,
    write(batch) {
      batches.push(batch);
      return Promise.resolve();
    },
  };
}

function handlerWith(sink: Sink) {
  return createDrainHandler({
    secret: SECRET,
    verifyCode: VERIFY_CODE,
    sinks: [sink],
    onBatch: () => {},
  });
}

async function signedPost(body: string): Promise<Request> {
  return new Request("https://example.test/vercel-drain", {
    method: "POST",
    headers: { "x-vercel-signature": await signBody(SECRET, body) },
    body,
  });
}

const fixture = (name: string): Promise<string> =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

Deno.test("verify header is attached to every response", async () => {
  const handler = handlerWith(collectingSink());

  const get = await handler(
    new Request("https://example.test/", { method: "GET" }),
  );
  assertEquals(get.status, 200);
  assertEquals(get.headers.get(VERIFY_HEADER), VERIFY_CODE);

  const unsigned = await handler(
    new Request("https://example.test/", { method: "POST", body: "[]" }),
  );
  assertEquals(unsigned.status, 401);
  assertEquals(unsigned.headers.get(VERIFY_HEADER), VERIFY_CODE);

  const put = await handler(
    new Request("https://example.test/", { method: "PUT", body: "x" }),
  );
  assertEquals(put.status, 405);
  assertEquals(put.headers.get(VERIFY_HEADER), VERIFY_CODE);
});

Deno.test("signed delivery lands rows in the sink", async () => {
  const sink = collectingSink();
  const handler = handlerWith(sink);
  const body = await fixture("lambda.ndjson");

  const response = await handler(await signedPost(body));
  assertEquals(response.status, 200);
  const summary = await response.json();
  assertEquals(summary, { received: 4, rows: 4, malformed: 0 });

  assertEquals(sink.batches.length, 1);
  assertEquals(sink.batches[0].rows.length, 4);
  assertEquals(sink.batches[0].body, body);
});

Deno.test("bad signature is rejected and nothing is written", async () => {
  const sink = collectingSink();
  const handler = handlerWith(sink);
  const body = await fixture("lambda.ndjson");

  const response = await handler(
    new Request("https://example.test/", {
      method: "POST",
      headers: { "x-vercel-signature": "0".repeat(40) },
      body,
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(sink.batches.length, 0);
});

Deno.test("malformed lines are counted, not fatal", async () => {
  const sink = collectingSink();
  const handler = handlerWith(sink);

  const response = await handler(
    await signedPost(await fixture("malformed.ndjson")),
  );
  assertEquals(response.status, 200);
  const summary = await response.json();
  assertEquals(summary, { received: 3, rows: 2, malformed: 3 });
  assertEquals(sink.batches[0].rows.length, 2);
});

Deno.test("empty signed body (verification ping) returns 200, skips sinks", async () => {
  const sink = collectingSink();
  const handler = handlerWith(sink);

  const response = await handler(await signedPost("[]"));
  assertEquals(response.status, 200);
  assertEquals(sink.batches.length, 0);
});

Deno.test("sink failure returns 500 so Vercel redelivers", async () => {
  const failing: Sink = {
    name: "failing",
    write: () => Promise.reject(new Error("boom")),
  };
  const handler = handlerWith(failing);

  const response = await handler(
    await signedPost(await fixture("lambda.ndjson")),
  );
  assertEquals(response.status, 500);
});

Deno.test("createDrainHandler refuses to run without a secret", () => {
  let threw = false;
  try {
    createDrainHandler({ secret: "", sinks: [] });
  } catch {
    threw = true;
  }
  assert(threw);
});
