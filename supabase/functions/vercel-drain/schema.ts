/**
 * Zod schema for Vercel log drain events.
 *
 * The schema is deliberately tolerant: only `id` and `timestamp` are
 * required, because they form the primary key of the logs table, and
 * everything else varies by source (`build` events have no `requestId`,
 * `static` events have no `level`, and so on). Unknown fields are
 * preserved via passthrough so they survive into the `raw` jsonb column
 * even when Vercel adds fields we have never seen.
 *
 * Reference: https://vercel.com/docs/drains/reference/logs
 */
import { z } from "zod";

/** The `proxy` object attached to request-shaped events. */
export interface VercelLogProxy {
  timestamp?: number;
  method?: string;
  scheme?: string;
  host?: string;
  path?: string;
  userAgent?: string[] | string;
  referer?: string;
  statusCode?: number;
  clientIp?: string;
  region?: string;
  cacheId?: string;
  vercelCache?: string;
  [key: string]: unknown;
}

/** A single Vercel log drain event, after validation. */
export interface VercelLogEvent {
  id: string;
  timestamp: number;
  message?: string;
  /** `stdout` | `stderr` */
  type?: string;
  /** build|edge|lambda|static|external|firewall|redirect */
  source?: string;
  /** info|warning|error|fatal */
  level?: string;
  /** production | preview */
  environment?: string;
  branch?: string;
  projectId?: string;
  projectName?: string;
  deploymentId?: string;
  buildId?: string;
  host?: string;
  path?: string;
  entrypoint?: string;
  destination?: string;
  requestId?: string;
  statusCode?: number;
  executionRegion?: string;
  traceId?: string;
  spanId?: string;
  proxy?: VercelLogProxy;
  [key: string]: unknown;
}

/** Validator for {@link VercelLogProxy}. */
export const proxySchema: z.ZodType<VercelLogProxy, z.ZodTypeDef, unknown> = z
  .object({
    timestamp: z.number().optional(),
    method: z.string().optional(),
    scheme: z.string().optional(),
    host: z.string().optional(),
    path: z.string().optional(),
    userAgent: z.union([z.array(z.string()), z.string()]).optional(),
    referer: z.string().optional(),
    statusCode: z.number().optional(),
    clientIp: z.string().optional(),
    region: z.string().optional(),
    cacheId: z.string().optional(),
    vercelCache: z.string().optional(),
  })
  .passthrough();

/** Validator for {@link VercelLogEvent}. */
export const logEventSchema: z.ZodType<VercelLogEvent, z.ZodTypeDef, unknown> =
  z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      timestamp: z.number(),
      message: z.string().optional(),
      type: z.string().optional(),
      source: z.string().optional(),
      level: z.string().optional(),
      environment: z.string().optional(),
      branch: z.string().optional(),
      projectId: z.string().optional(),
      projectName: z.string().optional(),
      deploymentId: z.string().optional(),
      buildId: z.string().optional(),
      host: z.string().optional(),
      path: z.string().optional(),
      entrypoint: z.string().optional(),
      destination: z.string().optional(),
      requestId: z.string().optional(),
      statusCode: z.number().optional(),
      executionRegion: z.string().optional(),
      traceId: z.string().optional(),
      spanId: z.string().optional(),
      proxy: proxySchema.optional(),
    })
    .passthrough();
