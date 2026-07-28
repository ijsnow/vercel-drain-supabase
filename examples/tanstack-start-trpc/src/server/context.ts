// tRPC context. The only correlation requirement: request headers must
// be available on ctx so the middleware can read x-vercel-id.
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

export async function createContext({ req }: FetchCreateContextFnOptions) {
  return {
    headers: req.headers,
    // Your real app resolves the session here; the middleware only needs
    // whatever identity you want joined against the logs.
    session: await resolveSession(req.headers),
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

async function resolveSession(
  _headers: Headers,
): Promise<{ userId: string } | null> {
  // Stand-in for your auth. Return { userId } when signed in.
  return null;
}
