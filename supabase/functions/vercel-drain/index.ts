// Vercel log drain receiver.
//
// Everything interesting lives in packages/drain; this file only wires
// environment variables to the handler. Once the package is published
// you can replace the relative import with:
//
//   import { handlerFromEnv } from "jsr:@ijsnow/vercel-drain-supabase@^0.1.0";
//
// Required secrets (supabase secrets set ...):
//   VERCEL_DRAIN_SECRET   hmac secret from the drain configuration
//   VERCEL_VERIFY_CODE    x-vercel-verify value shown during drain setup
// Optional:
//   DRAIN_ARCHIVE_BUCKET  private Storage bucket for the gzip archive
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// This function MUST run with verify_jwt disabled (see supabase/config.toml):
// Vercel sends no Supabase credentials. Authentication is the drain's
// HMAC signature, checked inside the handler.
import { handlerFromEnv } from "../../../packages/drain/mod.ts";

Deno.serve(handlerFromEnv(Deno.env.toObject()));
