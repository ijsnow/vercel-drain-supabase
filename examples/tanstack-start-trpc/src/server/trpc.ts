// tRPC initialization with the correlate middleware on every procedure.
// This is step 1 of the correlation loop: one structured line per
// request, carrying Vercel's request id plus domain identity.
import { initTRPC } from "@trpc/server";
import { correlateMiddleware } from "vercel-drain-correlate/trpc";
import type { Context } from "./context.ts";

const t = initTRPC.context<Context>().create();

const correlated = t.middleware(
  correlateMiddleware<Context>({
    getHeaders: (ctx) => ctx.headers,
    getIdentity: (ctx) => ({ userId: ctx.session?.userId ?? null }),
  }),
);

export const router = t.router;
// ctx.requestId is available in every procedure built from this.
export const procedure = t.procedure.use(correlated);
