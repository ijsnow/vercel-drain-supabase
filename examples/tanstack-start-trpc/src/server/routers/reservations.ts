// A mutation that stamps request_id onto the row it writes — step 3 of
// the correlation loop. With this in place, docs/queries.md recipe 1
// (reconciliation) and recipe 3 (errors by domain entity) work verbatim.
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { procedure, router } from "../trpc.ts";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export const reservationsRouter = router({
  create: procedure
    .input(z.object({ propertyId: z.string().uuid(), night: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await supabase
        .from("reservations")
        .insert({
          property_id: input.propertyId,
          night: input.night,
          user_id: ctx.session?.userId,
          // The stamp: this is what queries join on.
          request_id: ctx.requestId,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    }),
});
