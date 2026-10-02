import { z } from "zod";
import { ReleaseTypeSchema, ResolutionSchema } from "./media";

/**
 * User-tunable settings, stored in the database and edited by admins from the
 * web UI. Every field has a default, so an empty settings store parses into a
 * complete, usable configuration.
 *
 * Service connections and their API keys live here too. Keys are stored in
 * the database but never sent back to the browser: the settings response
 * blanks them and reports only whether each one is set.
 *
 * Deployment concerns — the HTTP port, the database file, the auth secret,
 * binary paths — are not here; they come from the server's environment.
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
  /** Only takes effect when an Anthropic API key is set under services. */
  enabled: z.boolean().default(true),
  model: z.string().min(1).default("claude-haiku-4-5"),
  maxCandidates: z.number().int().min(1).max(50).default(20),
  timeoutSeconds: z.number().int().min(1).max(120).default(20),
});

/**
 * How much each quality signal counts when ranking releases that passed the
 * hard filters. Weights are the most a signal can add; the rank tables they
 * scale (codecs, release types, groups) live in `@findr/config/scoring`.
 */
export const ScoringSettingsSchema = z.object({
  resolution: z.number().nonnegative().default(30),
  fileSize: z.number().nonnegative().default(25),
  seeders: z.number().nonnegative().default(25),
  codec: z.number().nonnegative().default(20),
  releaseType: z.number().nonnegative().default(20),
  releaseGroup: z.number().nonnegative().default(5),
  uploadDate: z.number().nonnegative().default(3),
  /** Corrected re-releases fix a known defect in the original, so nudge them up. */
  repack: z.number().nonnegative().default(2),
  /** Subtracted from 2160p releases larger than `bloated4KSizeGB` per movie or episode. */
  bloated4KPenalty: z.number().nonnegative().default(15),
  bloated4KSizeGB: z.number().positive().default(20),
  /** The size per movie that scores best; scores fall away on a bell curve either side. */
  idealMovieSizeGB: z.number().positive().default(4),
  /** The size per episode that scores best. */
  idealEpisodeSizeGB: z.number().positive().default(1.2),
  /** Seeder count beyond which more seeders stop adding score. */
  seederCap: z.number().int().min(1).default(1000),
});

/** An http(s) URL, or empty while not yet configured. */
const serviceUrl = z
  .string()
  .trim()
  .refine((value) => value === "" || /^https?:\/\/[^\s]+$/.test(value), "Must be an http(s) URL");

/** External services Findr calls, and the keys it calls them with. Empty means not configured. */
export const ServicesSettingsSchema = z.object({
  /** TMDB key, for browsing, metadata, episode lists and naming. */
  tmdbApiKey: z.string().trim().default(""),
  /** Base URL of the Prowlarr instance searched for releases. */
  prowlarrUrl: serviceUrl.default(""),
  prowlarrApiKey: z.string().trim().default(""),
  /** Enables the wrong-title filter. */
  anthropicApiKey: z.string().trim().default(""),
});

/** The fields of `services` that are secrets: stored, but never sent to the browser. */
export const SECRET_FIELDS = ["tmdbApiKey", "prowlarrApiKey", "anthropicApiKey"] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

/** The built-in torrent client. */
export const TorrentSettingsSchema = z.object({
  /**
   * TCP port for peers and UDP port for the DHT. `0` picks a random free port.
   * Read when the client starts, so a change applies after a restart.
   */
  port: z.number().int().min(0).max(65535).default(6881),
});

/** Who may reach the server at all. */
export const AccessSettingsSchema = z.object({
  /**
   * Accept requests from other machines. Off by default, so a fresh install
   * with its initial credentials is reachable only from the server itself.
   */
  allowRemote: z.boolean().default(false),
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
  scoring: ScoringSettingsSchema.prefault({}),
  services: ServicesSettingsSchema.prefault({}),
  torrent: TorrentSettingsSchema.prefault({}),
  access: AccessSettingsSchema.prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsSection = keyof Settings;
export type Preferences = Settings["preferences"];
export type PathsSettings = Settings["paths"];
export type NamingSettings = Settings["naming"];
export type WatchdogSettings = Settings["watchdog"];
export type LlmFilterSettings = Settings["llmFilter"];
export type ScoringSettings = Settings["scoring"];
export type ServicesSettings = Settings["services"];
export type TorrentSettings = Settings["torrent"];
export type AccessSettings = Settings["access"];

/**
 * An update from the settings page. Sections and fields are optional; only
 * what is present changes. Unknown keys are rejected so typos are caught.
 * An empty string for a secret clears it.
 */
export const SettingsPatchSchema = z
  .object({
    paths: PathsSettingsSchema.partial().strict(),
    naming: NamingSettingsSchema.partial().strict(),
    preferences: PreferencesSchema.partial().strict(),
    queue: QueueSettingsSchema.partial().strict(),
    watchdog: WatchdogSettingsSchema.partial().strict(),
    llmFilter: LlmFilterSettingsSchema.partial().strict(),
    scoring: ScoringSettingsSchema.partial().strict(),
    services: ServicesSettingsSchema.partial().strict(),
    torrent: TorrentSettingsSchema.partial().strict(),
    access: AccessSettingsSchema.partial().strict(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** What `GET /api/settings` returns: the settings with every secret blanked, plus which secrets are set. */
export interface SettingsResponse {
  settings: Settings;
  /** Whether each secret has a value, without revealing it. */
  configured: Record<SecretField, boolean>;
}
