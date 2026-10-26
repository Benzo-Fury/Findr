import { z } from "zod";
import { CredentialsResetSchema } from "./account";

/**
 * First-run setup: the tools Findr found, what an admin still has to fill in
 * before downloads can work, and claiming a fresh install from another
 * machine with the setup code its log prints.
 */

// ---------- Tools ---------- //

/** The external binaries Findr runs. */
export type ToolName = "ffmpeg" | "ffprobe";

/** Where a binary was found: the environment, inside the executable, or on `PATH`. */
export type ToolSource = "env" | "embedded" | "path";

/** One binary, found or not. */
export interface ToolStatus {
  name: ToolName;
  /** Null when it was found nowhere. */
  path: string | null;
  version: string | null;
  source: ToolSource | null;
}

// ---------- Status ---------- //

/** One library folder: whether it is set, exists and Findr may write to it. */
export interface PathStatus {
  set: boolean;
  exists: boolean;
  writable: boolean;
}

/** `GET /api/setup`: everything the setup wizard checks. */
export interface SetupStatus {
  tools: ToolStatus[];
  tmdb: { configured: boolean };
  prowlarr: {
    configured: boolean;
    /** Whether Prowlarr answered with this URL and key; null when it isn't configured. */
    reachable: boolean | null;
  };
  paths: { downloads: PathStatus; movies: PathStatus; series: PathStatus };
  /** Every required item passes, so downloads can work. */
  complete: boolean;
}

/** `GET /api/setup` query: `refresh` looks for the tools again. */
export const SetupStatusQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
});
export type SetupStatusQuery = z.infer<typeof SetupStatusQuerySchema>;

// ---------- Claim ---------- //

/** `GET /api/setup/claim`: whether the initial admin is still unclaimed, and whether this request is from the server itself. */
export interface ClaimStatus {
  pending: boolean;
  local: boolean;
}

/** `POST /api/setup/claim`: the setup code from the server's log, and the credentials that replace `admin` / `admin`. */
export const SetupClaimSchema = CredentialsResetSchema.extend({
  code: z.string().trim().min(1).max(32),
});
export type SetupClaim = z.infer<typeof SetupClaimSchema>;
