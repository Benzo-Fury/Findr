import { z } from "zod";
import { ReleaseTypeSchema, ResolutionSchema } from "./media";

/**
 * User-tunable settings, stored in the database and edited by admins from the
 * web UI. Every field has a default, so an empty settings store parses into a
 * complete, usable configuration.
 *
 * Deployment concerns — ports, secrets, service URLs, binary paths — are not
 * here; they come from the server's environment.
 */

/** Absolute POSIX or Windows path, or empty while not yet configured. */
const directory = z
  .string()
  .trim()
  .refine((value) => value === "" || /^(\/|[A-Za-z]:[\\/])/.test(value), "Must be an absolute path");

// ---------- Sections ---------- //

/** Where files are staged and where finished media lands. */
export const PathsSettingsSchema = z.object({
  /** Scratch space for in-progress attempts. Each attempt gets its own subdirectory. */
  downloads: directory.default(""),
  movies: directory.default(""),
  series: directory.default(""),
});

/** Library naming templates. `.mkv` is appended automatically. */
export const NamingSettingsSchema = z.object({
  movieFolder: z.string().min(1).default("{title} ({year})"),
  movieFile: z.string().min(1).default("{title} ({year})"),
  seriesFolder: z.string().min(1).default("{title} ({year})"),
  seasonFolder: z.string().min(1).default("Season {season}"),
  seriesFile: z.string().min(1).default("{title} - S{season}E{episode}"),
});

/**
 * How candidates are filtered and ranked. Ordered arrays use index as
 * priority — a lower index is preferred.
 */
export const PreferencesSchema = z.object({
  /** Resolutions in order of preference. Anything absent scores nothing for resolution. */
  resolutions: z.array(ResolutionSchema).default(["1080p", "720p", "2160p"]),
  /** Ceiling per movie or per episode; season packs scale it by episode count. */
  maxFileSizeGB: z.number().positive().default(10),
  minSeeders: z.number().int().nonnegative().default(5),
  blacklistedReleaseTypes: z.array(ReleaseTypeSchema).default(["CAM", "TS", "SCR"]),
});

/** Concurrency and how hard a download tries before giving up. */
export const QueueSettingsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  /** Failed attempts allowed per movie, season pack stage, or episode before it fails. */
  maxAttempts: z.number().int().min(1).max(25).default(5),
});

/** Thresholds that abandon a torrent which is not going to finish. */
export const WatchdogSettingsSchema = z.object({
  /** How long a magnet may take to resolve its file list. */
  metadataTimeoutMinutes: z.number().positive().default(5),
  /** How long a download may go without receiving a single new byte. */
  stallTimeoutMinutes: z.number().positive().default(10),
  /** Average speed floor over the speed window. Zero disables the check. */
  minSpeedKBps: z.number().nonnegative().default(50),
  speedWindowMinutes: z.number().positive().default(10),
  pollIntervalSeconds: z.number().int().min(1).max(60).default(5),
});

/** Optional LLM pass that drops releases which are clearly the wrong title. */
export const LlmFilterSettingsSchema = z.object({
  /** Only takes effect when `ANTHROPIC_API_KEY` is set on the server. */
  enabled: z.boolean().default(true),
  model: z.string().min(1).default("claude-haiku-4-5"),
  maxCandidates: z.number().int().min(1).max(50).default(20),
  timeoutSeconds: z.number().int().min(1).max(120).default(20),
});

// ---------- Settings ---------- //

/** Every section, keyed as stored. `prefault` runs each section's field defaults when absent. */
export const SettingsSchema = z.object({
  paths: PathsSettingsSchema.prefault({}),
  naming: NamingSettingsSchema.prefault({}),
  preferences: PreferencesSchema.prefault({}),
  queue: QueueSettingsSchema.prefault({}),
  watchdog: WatchdogSettingsSchema.prefault({}),
  llmFilter: LlmFilterSettingsSchema.prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsSection = keyof Settings;
export type Preferences = Settings["preferences"];
export type PathsSettings = Settings["paths"];
export type NamingSettings = Settings["naming"];
export type WatchdogSettings = Settings["watchdog"];
export type LlmFilterSettings = Settings["llmFilter"];

/**
 * An update from the settings page. Sections and fields are optional; only
 * what is present changes. Unknown keys are rejected so typos are caught.
 */
export const SettingsPatchSchema = z
  .object({
    paths: PathsSettingsSchema.partial().strict(),
    naming: NamingSettingsSchema.partial().strict(),
    preferences: PreferencesSchema.partial().strict(),
    queue: QueueSettingsSchema.partial().strict(),
    watchdog: WatchdogSettingsSchema.partial().strict(),
    llmFilter: LlmFilterSettingsSchema.partial().strict(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** What `GET /api/settings` returns: the settings plus server capabilities the page should know about. */
export interface SettingsResponse {
  settings: Settings;
  /** Whether the server has an Anthropic key, without revealing it. */
  llmAvailable: boolean;
}
