// Vercel log drain receiver.
//
// Verifies each delivery's HMAC-SHA1 signature, parses the NDJSON batch,
// normalizes it, and writes it over a direct Postgres connection into the
// unexposed `drain` schema. The logic lives in the sibling modules; this
// file only wires environment variables to the handler.
//
// Required secrets (supabase secrets set ...):
//   VERCEL_DRAIN_SECRET   hmac secret from the drain configuration
//   VERCEL_VERIFY_CODE    x-vercel-verify value shown during drain setup
// Optional:
//   DRAIN_DB_URL          override for the injected SUPABASE_DB_URL
//   DRAIN_ARCHIVE_BUCKET  private Storage bucket for the gzip archive
//
// SUPABASE_DB_URL is injected automatically and is what the Postgres sink
// connects through.
//
// This function MUST run with verify_jwt disabled (see supabase/config.toml):
// Vercel sends no Supabase credentials. Authentication is the drain's
// HMAC signature, checked inside the handler.
import { handlerFromEnv } from "./handler.ts";

Deno.serve(handlerFromEnv(Deno.env.toObject()));
