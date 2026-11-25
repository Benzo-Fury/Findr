/**
 * The Admin page's figures: storage, how downloads went, what the library
 * holds, how it is watched, and the health of everything Findr depends on.
 * `GET /api/admin/stats` answers for one period; `GET /api/admin/health`
 * checks the services live.
 */

import { z } from "zod";
import type { DownloadStatus } from "./downloads";
import type { MediaType } from "./media";
import type { TranscodeRung } from "./playback";

// ---------- Query ---------- //

/** The periods the Admin page can be viewed over. */
export const AdminRangeSchema = z.enum(["7d", "30d", "90d"]);
export type AdminRange = z.infer<typeof AdminRangeSchema>;

/** How many days each period covers. */
export const ADMIN_RANGE_DAYS: Record<AdminRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** `GET /api/admin/stats` query. */
export const AdminStatsQuerySchema = z.object({ range: AdminRangeSchema.default("30d") });
export type AdminStatsQuery = z.infer<typeof AdminStatsQuerySchema>;

// ---------- Storage ---------- //

/** What Findr keeps on one disk, in bytes. */
export interface DiskParts {
  movies: number;
  tv: number;
  /** Downloads in progress and their leftovers. */
  downloads: number;
  /** Playback's conversion scratch space and trickplay images. */
  playback: number;
}

/** One disk holding any of Findr's folders. */
export interface DiskUsage {
  /** The Findr folders on this disk, library folders first. */
  folders: string[];
  totalBytes: number;
  freeBytes: number;
  /** Findr's share of the used space; the rest belongs to other files. */
  parts: DiskParts;
}

export interface AdminStorage {
  /** Every disk Findr writes to, the movie library's first. Empty when no folder is set yet. */
  disks: DiskUsage[];
  /** Bytes added to the library per week, averaged over the last four weeks. Null before anything was added. */
  weeklyGrowthBytes: number | null;
}

// ---------- Downloads ---------- //

/** A finished download, for outcomes by day and time to the library. */
export interface FinishedDownload {
  /** When it finished, in epoch milliseconds. */
  at: number;
  status: Extract<DownloadStatus, "completed" | "partial" | "failed" | "cancelled">;
  /** Milliseconds from the request to finishing. */
  durationMs: number;
}

/** One release that downloaded completely, timed. */
export interface SpeedSample {
  /** When it finished, in epoch milliseconds. */
  at: number;
  bytesPerSecond: number;
}

/** The steps of an attempt that are timed. */
export type AttemptStep = "metadata" | "downloading" | "sterilizing" | "saving";

/** How one indexer's releases did. */
export interface IndexerStats {
  name: string;
  /** Releases it returned to searches. */
  found: number;
  /** Releases Findr tried to download. */
  tried: number;
  /** Of those, how many reached the library. */
  worked: number;
  medianBytes: number | null;
  /** Average download speed of its releases that finished. Null before any was timed. */
  bytesPerSecond: number | null;
}

export interface AdminDownloads {
  /** Downloads asked for in the period. */
  requested: number;
  finished: FinishedDownload[];
  speeds: SpeedSample[];
  /** For each file that reached the library, how many releases were tried to get it, as counts by number of releases. */
  releasesTried: Array<{ releases: number; count: number }>;
  /** Why Findr gave up on a release and tried another, grouped, most common first. */
  dropReasons: Array<{ reason: string; count: number }>;
  /** Median time spent in each step by releases that reached the library. Empty before any was timed. */
  steps: Array<{ step: AttemptStep; medianMs: number }>;
  /** How many releases the step times come from. */
  timedReleases: number;
  indexers: IndexerStats[];
}

// ---------- Library ---------- //

/** A label and how many files carry it. */
export interface MixPart {
  label: string;
  count: number;
}

/** A title and the space its files take. */
export interface LibraryTitleSize {
  titleId: string;
  tmdbId: number;
  mediaType: MediaType;
  bytes: number;
  files: number;
}

export interface AdminLibrary {
  movies: number;
  shows: number;
  episodes: number;
  durationMs: number;
  bytes: number;
  largest: LibraryTitleSize[];
  mix: {
    resolution: MixPart[];
    video: MixPart[];
    range: MixPart[];
    audio: MixPart[];
  };
}

// ---------- Playback ---------- //

/** How a play reached its screen. */
export type DeliveryKind = "direct" | "copied" | "audio" | "video";

/** A title and how much of it was watched. */
export interface WatchedTitle {
  titleId: string;
  tmdbId: number;
  mediaType: MediaType;
  /** Films or episodes watched in the period. */
  items: number;
  watchedMs: number;
}

/** One account's activity. */
export interface PersonStats {
  id: string;
  name: string;
  email: string;
  admin: boolean;
  requests: number;
  /** Films or episodes watched in the period. */
  items: number;
  watchedMs: number;
}

export interface AdminPlayback {
  /** Plays logged in the period, each a session that ran for at least a minute. */
  plays: number;
  delivery: Array<{ kind: DeliveryKind; count: number }>;
  /** Where video conversions ran, for plays that converted video. */
  rungs: Array<{ rung: TranscodeRung; count: number }>;
  credits: {
    episodes: number;
    /** Episodes whose end credits were found. */
    found: number;
    /** Found by looking them up online rather than reading the file. */
    online: number;
  };
  mostWatched: WatchedTitle[];
  people: PersonStats[];
}

// ---------- Response ---------- //

/** `GET /api/admin/stats`. */
export interface AdminStats {
  range: AdminRange;
  /** Start of the period, in epoch milliseconds. */
  since: number;
  generatedAt: number;
  storage: AdminStorage;
  downloads: AdminDownloads;
  library: AdminLibrary;
  playback: AdminPlayback;
}

// ---------- Health ---------- //

/** How a service is doing: fine, worth a look, broken, or turned off. */
export type ServiceState = "ok" | "warn" | "bad" | "off";

/** One thing Findr depends on. */
export interface ServiceHealth {
  key: string;
  name: string;
  state: ServiceState;
  /** A short figure, such as a response time. */
  value: string;
  detail: string;
}

/** `GET /api/admin/health`. */
export interface AdminHealth {
  services: ServiceHealth[];
  server: {
    version: string;
    /** The newer release ready to install, if any. */
    update: string | null;
    startedAt: number;
    platform: string;
  };
}
