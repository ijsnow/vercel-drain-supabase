# Example: TanStack Start + tRPC + correlate

The smallest complete wiring of the correlation loop in a TanStack Start
app using tRPC. These files are the pieces you graft into your own app —
the example shows every line the loop needs and nothing else.

What the loop requires:

1. **Headers reach your tRPC context** (`src/server/context.ts`).
2. **Every procedure runs the correlate middleware** (`src/server/trpc.ts`),
   which emits one `{"vdc":1,...}` line per call and puts `requestId` on
   `ctx`.
3. **Writes are stamped** with `ctx.requestId` (`src/server/routers/reservations.ts`),
   into a `request_id text` column on your own tables
   (`migrations/add_request_id.sql`).

Once deployed behind the drain, the queries in
[`docs/queries.md`](../../docs/queries.md) work as written.

Run locally with `npm install && npm run dev` after copying the files
into a TanStack Start scaffold (`npm create @tanstack/start@latest`).
Locally `x-vercel-id` is absent, so `requestId` is `null` and everything
degrades gracefully; on Vercel it is populated automatically.
