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
 * Deployment concerns — the database file, binary paths, proxy trust — are
 * not here; they come from the server's environment. The auth secret is
 * neither: the server generates it and keeps it beside the database.
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
  /**
   * How long any step of an attempt may go without a sign of life — a torrent
   * poll answering, remux progress, bytes copied — before it counts as stuck.
   */
  stuckTimeoutMinutes: z.number().positive().default(10),
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

/** The port Findr serves the web app and API on unless the settings say otherwise. */
export const DEFAULT_PORT = 34571;

/** Who may reach the server at all, and where. */
export const AccessSettingsSchema = z.object({
  /**
   * The HTTP port for the web app and API. Read when the server starts, so a
   * change applies after a restart. The `PORT` environment variable overrides it.
   */
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  /**
   * The address people open Findr at when it is not `localhost` or an IP —
   * a hostname or a reverse proxy's URL. Empty means `http://localhost:<port>`.
   * Sign-ins are only accepted from pages served at these addresses. Read
   * when the server starts.
   */
  publicUrl: serviceUrl.default(""),
  /**
   * Accept requests from other machines. Off by default, so a fresh install
   * with its initial credentials is reachable only from the server itself.
   */
  allowRemote: z.boolean().default(false),
});

/** IPv4 or IPv6 addresses separated by commas, or empty. */
const addressList = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || value.split(",").every((part) => z.union([z.ipv4(), z.ipv6()]).safeParse(part.trim()).success),
    "Must be IP addresses separated by commas",
  );

/**
 * The VPN killswitch. While it is on, every torrent connection is bound to the
 * VPN interface's address, and the torrent client runs only while the VPN
 * checks pass: the moment one fails every torrent connection is cut, and
 * downloads wait until the VPN is back.
 */
export const VpnSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * The VPN's network interface, such as `wg0` or `tun0`. A trailing `*`
   * matches by prefix (`utun*`). It counts as up while it holds an address
   * that is not link-local and the routes to the internet go through it.
   * Required while the killswitch is on: torrents are bound to its address.
   */
  interfaceName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.:-]*\*?$/, "Must be an interface name, optionally ending in *")
    .default(""),
  /**
   * Public addresses that mean traffic is not going through the VPN — usually
   * the home connection's. When set, the public address is looked up and the
   * killswitch trips if it is one of these, or if it cannot be looked up.
   */
  homeIps: addressList.default(""),
});

/** Findr's own updates, published as GitHub releases. Checked at startup and every few hours. */
export const UpdatesSettingsSchema = z.object({
  /**
   * Install a new release as soon as no downloads are queued or running, then
   * restart. Only a standalone executable can update itself.
   */
  autoInstall: z.boolean().default(false),
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
  vpn: VpnSettingsSchema.prefault({}),
  updates: UpdatesSettingsSchema.prefault({}),
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
export type VpnSettings = Settings["vpn"];
export type UpdatesSettings = Settings["updates"];

/**
 * One section's patch: every field optional and its default removed. A plain
 * `partial()` keeps the defaults, which would fill every omitted field and
 * overwrite the stored value with it.
 */
function patchOf<Shape extends z.ZodRawShape>(section: z.ZodObject<Shape>) {
  const fields = Object.fromEntries(
    Object.entries(section.shape).map(([key, field]) => [
      key,
      z.optional(field instanceof z.ZodDefault ? field.removeDefault() : field),
    ]),
  );
  return z.object(fields).strict() as unknown as ReturnType<typeof section.partial>;
}

/**
 * An update from the settings page. Sections and fields are optional; only
 * what is present changes. Unknown keys are rejected so typos are caught.
 * An empty string for a secret clears it.
 */
export const SettingsPatchSchema = z
  .object({
    paths: patchOf(PathsSettingsSchema),
    naming: patchOf(NamingSettingsSchema),
    preferences: patchOf(PreferencesSchema),
    queue: patchOf(QueueSettingsSchema),
    watchdog: patchOf(WatchdogSettingsSchema),
    llmFilter: patchOf(LlmFilterSettingsSchema),
    scoring: patchOf(ScoringSettingsSchema),
    services: patchOf(ServicesSettingsSchema),
    torrent: patchOf(TorrentSettingsSchema),
    access: patchOf(AccessSettingsSchema),
    vpn: patchOf(VpnSettingsSchema),
    updates: patchOf(UpdatesSettingsSchema),
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
