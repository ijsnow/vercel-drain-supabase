/**
 * tRPC middleware for the correlation loop.
 *
 * Deliberately has no dependency on `@trpc/server`: it returns a plain
 * function matching the middleware call signature, typed loosely enough
 * to pass to `t.middleware(...)` on tRPC v10 and v11.
 *
 * ```ts
 * import { initTRPC } from "@trpc/server";
 * import { correlateMiddleware } from "vercel-drain-correlate/trpc";
 *
 * const t = initTRPC.context<Context>().create();
 *
 * const correlated = t.middleware(correlateMiddleware<Context>({
 *   getHeaders: (ctx) => ctx.headers,
 *   getIdentity: (ctx) => ({ userId: ctx.session?.userId ?? null }),
 * }));
 *
 * export const procedure = t.procedure.use(correlated);
 * // In procedures: ctx.requestId is set; stamp it onto rows you write.
 * ```
 */
import {
  getRequestId,
  type HeadersLike,
  type Identity,
  logCorrelation,
} from "./index.ts";

/** The subset of the tRPC middleware options object we rely on. */
export interface MiddlewareInput<Ctx> {
  ctx: Ctx;
  /** Procedure path, e.g. `reservations.create`. */
  path: string;
  /** `query` | `mutation` | `subscription`. */
  type: string;
  next: (opts?: { ctx: Ctx & { requestId: string | null } }) => Promise<unknown>;
}

export interface CorrelateMiddlewareOptions<Ctx> {
  /** Where request headers live in your context. */
  getHeaders: (ctx: Ctx) => HeadersLike | null | undefined;
  /** Domain identity to attach to every line: user id, tenant id, ... */
  getIdentity?: (ctx: Ctx) => Identity;
  /** Custom line writer; defaults to `console.log` (stdout → drain). */
  write?: (line: string) => void;
}

/**
 * Build the middleware. Emits one correlation line per procedure call
 * (`{"vdc":1,"requestId":...,"procedure":...,...identity}`) and extends
 * `ctx` with `requestId` so procedures can stamp database writes.
 */
export function correlateMiddleware<Ctx>(
  options: CorrelateMiddlewareOptions<Ctx>,
) {
  return async (input: MiddlewareInput<Ctx>): Promise<unknown> => {
    const headers = options.getHeaders(input.ctx);
    const requestId = headers ? getRequestId(headers) : null;
    logCorrelation(
      requestId,
      {
        procedure: input.path,
        type: input.type,
        ...(options.getIdentity?.(input.ctx) ?? {}),
      },
      options.write,
    );
    return input.next({ ctx: { ...input.ctx, requestId } });
  };
}
