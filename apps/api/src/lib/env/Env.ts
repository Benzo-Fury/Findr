/**
 * Application-level configuration read from the process environment.
 *
 * Only settings that belong to the deployment rather than the user live here:
 * the port, the database location, service URLs, and every secret. Anything a
 * user tunes while running Findr (library paths, naming, preferences, the
 * download watchdog) lives in the database settings store instead, so it can
 * be changed from the web UI without a restart or a rebuild.
 *
 * Bun loads `.env` from the working directory automatically, in development
 * and in a compiled executable alike.
 */

import { z } from "zod";

// ---------- Schema ---------- //

/** Accepts the usual spellings of a boolean flag in an env file. */
const flag = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((value) => value === "true" || value === "1");

/** Treats an empty string the same as an unset variable. */
const optional = z
  .string()
  .optional()
  .transform((value) => (value ? value : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3030),

  /** SQLite file. Relative paths resolve against the repo root, or the working directory when compiled. */
  DATABASE_PATH: z.string().default("findr.db"),

  /** Public origin of the server, used by BetterAuth for redirects and cookies. */
  BASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(1),

  /** Seeds the first admin account when the database has no users. */
  FINDR_ADMIN_EMAIL: optional,
  FINDR_ADMIN_PASSWORD: optional,

  /** Honour `X-Forwarded-For` when rate limiting. Only enable behind a trusted reverse proxy. */
  TRUST_PROXY: flag,

  TMDB_API_KEY: optional,

  PROWLARR_URL: optional,
  PROWLARR_API_KEY: optional,

  QBT_URL: z.string().default("http://localhost:8080"),
  QBT_USERNAME: optional,
  QBT_PASSWORD: optional,

  /** Enables the LLM relevance filter when present. */
  ANTHROPIC_API_KEY: optional,
});

/** The validated environment, with defaults applied. */
export type EnvValues = z.infer<typeof EnvSchema>;

// ---------- Env ---------- //

/**
 * Parses and exposes the environment once per process. Startup fails loudly on
 * a malformed environment rather than letting a bad value surface later as a
 * confusing runtime error deep inside a download.
 */
export class Env {
  /**
   * Validates `process.env` against the schema, printing every problem and
   * exiting when anything required is missing or malformed.
   */
  public static load(source: Record<string, string | undefined> = process.env): EnvValues {
    // Read NODE_ENV as a member expression so the build's `define` inlines
    // "production" here too, matching the dead-code elimination elsewhere
    const result = EnvSchema.safeParse({ ...source, NODE_ENV: process.env.NODE_ENV });
    if (result.success) return result.data;

    // Report each invalid variable by name before bailing out
    console.error("[Env] Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
}

/** Process-wide validated environment. */
export const env = Env.load();
