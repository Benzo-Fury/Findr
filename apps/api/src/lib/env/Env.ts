/**
 * Application-level configuration read from the process environment.
 *
 * Only settings that belong to the deployment rather than the user live here:
 * the database location, proxy trust, the mkvmerge binary, a port override,
 * and where updates come from. None is required, so Findr starts with no `.env` at all.
 * Everything an admin tunes while running Findr — library paths, naming,
 * preferences, the watchdog, service URLs and API keys, the ports, remote
 * access — lives in the database settings store instead, so it can be
 * changed from the web UI without editing files on the server. The auth
 * secret is generated on first run and kept beside the database (`AuthSecret`).
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

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /**
   * Overrides the port set under Settings → Access. Unset normally; it is the
   * way back in when the configured port is taken and the server cannot start.
   */
  PORT: z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().min(1).max(65535).optional()),

  /** SQLite file. Relative paths resolve against the repo root, or the working directory when compiled. */
  DATABASE_PATH: z.string().default("data/findr.db"),

  /**
   * Honour `X-Forwarded-For` for rate limiting and the remote access check.
   * Only enable behind a trusted reverse proxy.
   */
  TRUST_PROXY: flag,

  /**
   * The mkvmerge binary. Deliberately an env var rather than a UI setting: an
   * executable path editable from the browser would let a hijacked admin
   * session run arbitrary programs on the server.
   */
  MKVMERGE_PATH: z.string().default("mkvmerge"),

  /** Where new versions are looked for: a GitHub API "latest release" URL. Lets a fork follow its own releases. */
  UPDATES_URL: z.url().default("https://api.github.com/repos/Benzo-Fury/Findr/releases/latest"),

  /**
   * Whether Findr runs in a container, which is updated by pulling a new image
   * rather than by Findr itself. Unset means detect it from the runtime's
   * marker files; an image sets it to `true` to declare itself.
   */
  FINDR_CONTAINER: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value === "true" || value === "1")),
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
