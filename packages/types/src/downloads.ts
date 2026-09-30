import { z } from "zod";
import { MediaTypeSchema } from "./media";
import { ParsedReleaseSchema } from "./release";

/**
 * Request and response shapes for `/api/downloads` and `/api/titles`. The API
 * validates requests against these schemas and returns these types, and the
 * web app consumes the same definitions.
 */

// ---------- Status vocabularies ---------- //

/**
 * A download's lifecycle. `searching` covers query, parse, score and filter;
 * `downloading` covers the attempt loop (download, inspect, sterilize, save).
 * `partial` means a season finished with some episodes saved and some not.
 */
export const DownloadStatusSchema = z.enum([
  "queued",
  "searching",
  "downloading",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export type DownloadStatus = z.infer<typeof DownloadStatusSchema>;

/** Statuses a download never leaves on its own. */
export const TERMINAL_DOWNLOAD_STATUSES: readonly DownloadStatus[] = [
  "completed",
  "partial",
  "failed",
  "cancelled",
];

/** Per-episode lifecycle for season downloads. `unaired` episodes are skipped, not failed. */
export const EpisodeStatusSchema = z.enum([
  "pending",
  "searching",
  "downloading",
  "completed",
  "failed",
  "unaired",
  "cancelled",
]);
export type EpisodeStatus = z.infer<typeof EpisodeStatusSchema>;

/** Where a candidate stands. `rejected` carries a reason; `attempting` means an attempt is live. */
export const CandidateStatusSchema = z.enum(["pending", "attempting", "rejected", "succeeded"]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

/** The step a live attempt is on. */
export const AttemptPhaseSchema = z.enum(["metadata", "downloading", "sterilizing", "saving", "done"]);
export type AttemptPhase = z.infer<typeof AttemptPhaseSchema>;

/** How an attempt ended. Null while it is still running. */
export const AttemptOutcomeSchema = z.enum(["succeeded", "failed", "interrupted", "cancelled"]);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

// ---------- Records ---------- //

/** What a finished download produced. */
export interface DownloadResult {
  /** Absolute library paths of every file saved. */
  files: string[];
  /** Season downloads only: episode numbers by outcome. */
  episodes?: { completed: number[]; failed: number[]; unaired: number[] };
}

/** The attempt currently running for a download, for live progress display. */
export interface ActiveAttempt {
  phase: AttemptPhase;
  /** 0–1 within the current phase. */
  progress: number;
  candidateTitle: string;
  episodeNumber: number | null;
}

export interface DownloadSummary {
  id: string;
  titleId: string;
  tmdbId: number;
  mediaType: z.infer<typeof MediaTypeSchema>;
  /** Null for movies. */
  season: number | null;
  status: DownloadStatus;
  statusMessage: string | null;
  result: DownloadResult | null;
  /** Increments each time the download is retried, grouping attempts by run. */
  run: number;
  requestedBy: string | null;
  createdAt: number;
  updatedAt: number;
  activeAttempt: ActiveAttempt | null;
}

export interface EpisodeRecord {
  id: string;
  episodeNumber: number;
  status: EpisodeStatus;
  statusMessage: string | null;
}

/**
 * A release considered for a download. Contains no download links — magnets
 * and indexer URLs stay on the server.
 */
export interface CandidateRecord {
  id: string;
  /** Null for movies and season packs; set for per-episode candidates. */
  episodeId: string | null;
  title: string;
  indexer: string;
  sizeMB: number;
  seeders: number;
  leechers: number;
  publishedAt: number | null;
  parsed: z.infer<typeof ParsedReleaseSchema>;
  /** Null when a hard filter rejected it before scoring. */
  score: number | null;
  status: CandidateStatus;
  rejectionReason: string | null;
  /** Chosen manually on retry, so it is tried before anything else. */
  pinned: boolean;
}

export interface AttemptRecord {
  id: string;
  candidateId: string;
  episodeId: string | null;
  run: number;
  phase: AttemptPhase;
  progress: number;
  outcome: AttemptOutcome | null;
  reason: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface DownloadDetail extends DownloadSummary {
  episodes: EpisodeRecord[];
  candidates: CandidateRecord[];
  attempts: AttemptRecord[];
}

export interface TitleSummary {
  id: string;
  tmdbId: number;
  mediaType: z.infer<typeof MediaTypeSchema>;
  createdAt: number;
  /** Every download for the title, newest first. */
  downloads: DownloadSummary[];
}

/** Envelope for every paginated list. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------- Requests ---------- //

/** Hard server-side ceiling on page size, whatever the client asks for. */
export const MAX_PAGE_SIZE = 100;

/** Query parameters shared by every paginated list. */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const ListDownloadsQuerySchema = PageQuerySchema.extend({
  status: DownloadStatusSchema.optional(),
  /** `active` narrows to every non-terminal status at once. */
  state: z.enum(["active", "finished"]).optional(),
});
export type ListDownloadsQuery = z.infer<typeof ListDownloadsQuerySchema>;

export const ListTitlesQuerySchema = PageQuerySchema.extend({
  tmdbId: z.coerce.number().int().positive().optional(),
  mediaType: MediaTypeSchema.optional(),
});
export type ListTitlesQuery = z.infer<typeof ListTitlesQuerySchema>;

/** Start a download. Series downloads are per season; movies take no season. */
export const CreateDownloadRequestSchema = z
  .object({
    tmdbId: z.number().int().positive(),
    mediaType: MediaTypeSchema,
    season: z.number().int().min(0).optional(),
  })
  .refine((body) => (body.mediaType === "tv") === (body.season !== undefined), {
    message: "season is required for tv and not allowed for movies",
    path: ["season"],
  });
export type CreateDownloadRequest = z.infer<typeof CreateDownloadRequestSchema>;

/** Retry a finished download, optionally forcing a specific candidate first. */
export const RetryDownloadRequestSchema = z.object({
  candidateId: z.string().optional(),
});
export type RetryDownloadRequest = z.infer<typeof RetryDownloadRequestSchema>;
