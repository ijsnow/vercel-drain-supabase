import { test } from "node:test";
import assert from "node:assert/strict";
import { correlateMiddleware } from "./trpc.ts";

interface Ctx {
  headers: Headers;
  session?: { userId: string };
}

test("middleware logs procedure + identity and extends ctx", async () => {
  const lines: string[] = [];
  const middleware = correlateMiddleware<Ctx>({
    getHeaders: (ctx) => ctx.headers,
    getIdentity: (ctx) => ({ userId: ctx.session?.userId ?? null }),
    write: (l) => lines.push(l),
  });

  let seenCtx: unknown;
  await middleware({
    ctx: {
      headers: new Headers({ "x-vercel-id": "iad1::abc-123" }),
      session: { userId: "u1" },
    },
    path: "reservations.create",
    type: "mutation",
    next: (opts) => {
      seenCtx = opts?.ctx;
      return Promise.resolve("result");
    },
  });

  assert.deepEqual(JSON.parse(lines[0]), {
    vdc: 1,
    requestId: "abc-123",
    procedure: "reservations.create",
    type: "mutation",
    userId: "u1",
  });
  assert.equal((seenCtx as { requestId: string }).requestId, "abc-123");
});

test("middleware tolerates missing headers", async () => {
  const lines: string[] = [];
  const middleware = correlateMiddleware<{ headers?: Headers }>({
    getHeaders: (ctx) => ctx.headers,
    write: (l) => lines.push(l),
  });

  await middleware({
    ctx: {},
    path: "health.check",
    type: "query",
    next: () => Promise.resolve(null),
  });

  assert.equal(JSON.parse(lines[0]).requestId, null);
});
