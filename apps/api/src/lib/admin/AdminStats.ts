/**
 * Builds the Admin page's figures for one period: how full each disk is and
 * what fills it, how downloads went, what the library holds, and how it was
 * watched. Everything comes from the database and the filesystem; nothing is
 * cached, since an admin opens the page rarely and wants it current.
 *
 * Time series go out as individual events (a finished download, a timed
 * release) rather than per-day totals, so the browser can bin them by its own
 * days and hours.
 */

import { stat, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ADMIN_RANGE_DAYS,
  type AdminDownloads,
  type AdminLibrary,
  type AdminPlayback,
  type AdminRange,
  type AdminStats as AdminStatsRecord,
  type AdminStorage,
  type AttemptStep,
  type DeliveryKind,
  type DiskParts,
  type DiskUsage,
  type IndexerStats,
  type LibraryTitleSize,
  type MixPart,
  type PersonStats,
  type WatchedTitle,
} from "@findr/types/admin";
import type { TranscodeRung } from "@findr/types/playback";
import { Analytics, type LibraryFileRow, type TimedAttemptRow } from "../db/models/Analytics";
import { PlayLog, type PlayLogMode } from "../db/models/PlayLog";
import { SettingsStore } from "../db/models/SettingsStore";
import { StatfsProbe } from "../pipeline/DiskSpace";
import type { ProbeInfo } from "../playback/MediaProbe";
import PlaybackService from "../playback/PlaybackService";
import { Trickplay } from "../playback/Trickplay";

// ---------- Constants ---------- //

const DAY_MS = 86_400_000;

/** Growth is averaged over this many weeks. */
const GROWTH_WEEKS = 4;

/** Downloads shorter than this were already on disk (a resumed transfer), so their speed means nothing. */
const MIN_TIMED_DOWNLOAD_MS = 5_000;

/** Sessions shorter than this were someone looking, not watching. */
const MIN_PLAY_MS = 60_000;

/** How many titles the largest and most-watched lists hold. */
const TOP_TITLES = 5;

/** The steps of an attempt in the order they run. */
const STEPS: readonly AttemptStep[] = ["metadata", "downloading", "sterilizing", "saving"];

/** How each session mode reads on the page. */
const DELIVERY: Record<PlayLogMode, DeliveryKind> = { direct: "direct", remux: "copied", audio: "audio", transcode: "video" };

/**
 * Why a release was given up on, matched against the attempt's reason in
 * order, so specific wordings come before general ones. Anything unmatched is
 * "Something else".
 */
const DROP_REASONS: ReadonlyArray<[RegExp, string]> = [
  [/^Too slow/i, "Downloading too slowly"],
  [/^Stalled/i, "Stopped receiving data"],
  [/^No metadata/i, "Couldn't get the file list"],
  [/^Stuck/i, "Stopped responding"],
  [/^Incomplete season pack|^No file for S\d+E\d+/i, "Episodes missing from the pack"],
  [/blocked file type|Unsafe file path/i, "Unsafe files inside"],
  [/Archive-only|No video files|No full-length video|container Findr doesn't take/i, "No usable video inside"],
  [/unsupported codec/i, "Video or audio format not allowed"],
  [/not a Matroska or MP4|could not read the downloaded|no video stream|Sterilize failed/i, "Broken or unreadable file"],
  [/torrent|download client/i, "Torrent error"],
];

/** Common codec names as people know them. */
const CODEC_NAMES: Record<string, string> = {
  hevc: "HEVC",
  h264: "H.264",
  av1: "AV1",
  vp9: "VP9",
  mpeg4: "MPEG-4",
  mpeg2video: "MPEG-2",
  aac: "AAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  flac: "FLAC",
  opus: "Opus",
  mp3: "MP3",
  vorbis: "Vorbis",
};

// ---------- Helpers ---------- //

/** The middle value, or null for none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Counts per label, largest first. */
function tally(labels: string[]): MixPart[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** A download's average speed, or null when its transfer wasn't timed meaningfully. */
function speedOf(row: TimedAttemptRow): number | null {
  const downloading = row.timings.downloading ?? 0;
  if (!row.bytes || downloading < MIN_TIMED_DOWNLOAD_MS) return null;
  return row.bytes / (downloading / 1000);
}

// ---------- Builder ---------- //

export class AdminStats {
  private readonly probe = new StatfsProbe();

  /** Every figure for the period ending now. */
  public async build(range: AdminRange, now = Date.now()): Promise<AdminStatsRecord> {
    const since = now - ADMIN_RANGE_DAYS[range] * DAY_MS;
    const files = Analytics.libraryFiles();

    return {
      range,
      since,
      generatedAt: now,
      storage: await this.storage(files, now),
      downloads: this.downloads(since),
      library: this.library(files),
      playback: this.playback(since, files),
    };
  }

  // ---------- Storage ---------- //

  /** Each disk Findr writes to, with what of Findr's is on it. */
  private async storage(files: LibraryFileRow[], now: number): Promise<AdminStorage> {
    const { paths } = SettingsStore.load();
    const scratch = PlaybackService.getInstance().scratchRootOrNull(SettingsStore.section("playback"));
    const trickplay = Trickplay.root();
    const sizeOf = (type: "movie" | "tv") => files.filter((file) => file.mediaType === type).reduce((sum, file) => sum + file.size, 0);

    // What each folder holds, library folders first so the movie disk leads
    type Folder = { path: string; part: keyof DiskParts; bytes: () => Promise<number> };
    const candidates: Folder[] = [
      { path: paths.movies, part: "movies", bytes: async () => sizeOf("movie") },
      { path: paths.series, part: "tv", bytes: async () => sizeOf("tv") },
      { path: paths.downloads, part: "downloads", bytes: () => this.probe.allocated(paths.downloads) },
    ];
    if (scratch) candidates.push({ path: scratch, part: "playback", bytes: () => this.probe.allocated(scratch) });
    if (trickplay) candidates.push({ path: trickplay, part: "playback", bytes: () => this.probe.allocated(trickplay) });
    const folders = candidates.filter((folder) => folder.path);

    // Group the folders by the disk they sit on
    const disks = new Map<number, DiskUsage>();
    for (const folder of folders) {
      const volume = await this.volume(folder.path);
      if (!volume) continue;
      let disk = disks.get(volume.device);
      if (!disk) {
        disk = { folders: [], totalBytes: volume.totalBytes, freeBytes: volume.freeBytes, parts: { movies: 0, tv: 0, downloads: 0, playback: 0 } };
        disks.set(volume.device, disk);
      }
      if (!disk.folders.includes(folder.path)) disk.folders.push(folder.path);
      disk.parts[folder.part] += await folder.bytes().catch(() => 0);
    }

    // Growth: library files written over the last few weeks
    const recent = now - GROWTH_WEEKS * 7 * DAY_MS;
    const added = files.filter((file) => file.mtime >= recent).reduce((sum, file) => sum + file.size, 0);
    return { disks: [...disks.values()], weeklyGrowthBytes: files.length > 0 ? added / GROWTH_WEEKS : null };
  }

  /** The size and free space of the disk holding `path`, or its nearest existing parent. */
  private async volume(path: string): Promise<{ device: number; totalBytes: number; freeBytes: number } | null> {
    let current = resolve(path);
    while (true) {
      const info = await Promise.all([statfs(current), stat(current)]).catch(() => null);
      if (info) {
        const [fs, file] = info;
        return { device: file.dev, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  // ---------- Downloads ---------- //

  private downloads(since: number): AdminDownloads {
    const timed = Analytics.timedAttempts(since);

    // Speeds, for the chart and per indexer
    const speeds = timed.flatMap((row) => {
      const bytesPerSecond = speedOf(row);
      return bytesPerSecond === null ? [] : [{ at: row.finishedAt, bytesPerSecond, indexer: row.indexer }];
    });

    // Releases tried per file that made it, five and over together
    const tried = Analytics.releasesTried(since);
    const releasesTried = [1, 2, 3, 4, 5].map((releases) => ({
      releases,
      count: tried.filter((count) => (releases === 5 ? count >= 5 : count === releases)).length,
    }));

    // Why releases were given up on, grouped into plain reasons
    const dropReasons = tally(
      Analytics.failureReasons(since).map((reason) => DROP_REASONS.find(([pattern]) => pattern.test(reason))?.[1] ?? "Something else"),
    ).map((part) => ({ reason: part.label, count: part.count }));

    // The median of each step, over releases whose steps were all timed
    const complete = timed.filter((row) => STEPS.every((step) => row.timings[step] !== undefined));
    const steps = complete.length === 0 ? [] : STEPS.map((step) => ({ step, medianMs: median(complete.map((row) => row.timings[step] ?? 0)) ?? 0 }));

    return {
      requested: Analytics.requestedSince(since),
      finished: Analytics.finishedDownloads(since).map((row) => ({ at: row.updatedAt, status: row.status, durationMs: row.updatedAt - row.createdAt })),
      speeds: speeds.map(({ at, bytesPerSecond }) => ({ at, bytesPerSecond })),
      releasesTried,
      dropReasons,
      steps,
      timedReleases: complete.length,
      indexers: this.indexers(since, speeds),
    };
  }

  /** How each indexer's releases did, the most tried first. */
  private indexers(since: number, speeds: Array<{ indexer: string; bytesPerSecond: number }>): IndexerStats[] {
    const found = Analytics.releasesFound(since);
    const tried = Analytics.releasesTriedByIndexer(since);
    const names = new Set([...found.keys(), ...tried.map((row) => row.indexer)]);

    return [...names]
      .map((name) => {
        const releases = tried.filter((row) => row.indexer === name);
        const rates = speeds.filter((sample) => sample.indexer === name).map((sample) => sample.bytesPerSecond);
        const medianMB = median(releases.map((row) => row.sizeMB));
        return {
          name,
          found: found.get(name) ?? 0,
          tried: releases.length,
          worked: releases.filter((row) => row.worked).length,
          medianBytes: medianMB === null ? null : medianMB * 1024 * 1024,
          bytesPerSecond: rates.length === 0 ? null : rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
        };
      })
      .sort((a, b) => b.tried - a.tried || b.found - a.found);
  }

  // ---------- Library ---------- //

  private library(files: LibraryFileRow[]): AdminLibrary {
    // Space per title
    const titles = new Map<string, LibraryTitleSize>();
    for (const file of files) {
      const title = titles.get(file.titleId) ?? { titleId: file.titleId, tmdbId: file.tmdbId, mediaType: file.mediaType, bytes: 0, files: 0 };
      title.bytes += file.size;
      title.files += 1;
      titles.set(file.titleId, title);
    }
    const all = [...titles.values()];

    // What the files are made of
    // A probe that can't be read leaves that file out of the format mix rather than failing the page
    const probes = files.flatMap((file) => {
      try {
        return [JSON.parse(file.probe) as ProbeInfo];
      } catch {
        return [];
      }
    });
    return {
      movies: all.filter((title) => title.mediaType === "movie").length,
      shows: all.filter((title) => title.mediaType === "tv").length,
      episodes: files.filter((file) => file.mediaType === "tv").length,
      durationMs: files.reduce((sum, file) => sum + file.durationMs, 0),
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      largest: all.sort((a, b) => b.bytes - a.bytes).slice(0, TOP_TITLES),
      mix: {
        resolution: tally(probes.map((probe) => this.resolution(probe))),
        video: tally(probes.map((probe) => CODEC_NAMES[probe.video.codec] ?? probe.video.codec.toUpperCase())),
        range: tally(probes.map((probe) => this.dynamicRange(probe))),
        audio: tally(
          probes.map((probe) => {
            const codec = (probe.audio.find((track) => track.isDefault) ?? probe.audio[0])?.codec;
            return codec ? (CODEC_NAMES[codec] ?? codec.toUpperCase()) : "None";
          }),
        ),
      },
    };
  }

  /** A file's resolution class, judged by width as well so letterboxed films count by their real size. */
  private resolution({ video }: ProbeInfo): string {
    if (video.width >= 3200 || video.height >= 1800) return "4K";
    if (video.width >= 1700 || video.height >= 1000) return "1080p";
    if (video.width >= 1100 || video.height >= 650) return "720p";
    return "SD";
  }

  /** Whether a file is SDR, HDR10 or HLG. */
  private dynamicRange({ video }: ProbeInfo): string {
    if (video.transfer === "arib-std-b67") return "HLG";
    return video.hdr ? "HDR10" : "SDR";
  }

  // ---------- Playback ---------- //

  private playback(since: number, files: LibraryFileRow[]): AdminPlayback {
    const plays = PlayLog.since(since, MIN_PLAY_MS);
    const watched = Analytics.watched(since);

    // How plays reached screens, and where conversions ran
    const delivery = tally(plays.map((play) => DELIVERY[play.mode])).map((part) => ({ kind: part.label as DeliveryKind, count: part.count }));
    const rungs = tally(plays.flatMap((play) => (play.mode === "transcode" && play.rung ? [play.rung] : []))).map((part) => ({
      rung: part.label as TranscodeRung,
      count: part.count,
    }));

    // End credits found for episodes
    const episodes = files.filter((file) => file.mediaType === "tv");
    const found = episodes.filter((file) => file.creditsMs !== null);

    // The most watched titles
    const byTitle = new Map<string, WatchedTitle>();
    for (const row of watched) {
      const title = byTitle.get(row.titleId) ?? { titleId: row.titleId, tmdbId: row.tmdbId, mediaType: row.mediaType, items: 0, watchedMs: 0 };
      title.items += 1;
      title.watchedMs += row.watchedMs;
      byTitle.set(row.titleId, title);
    }

    return {
      plays: plays.length,
      delivery,
      rungs,
      credits: { episodes: episodes.length, found: found.length, online: found.filter((file) => file.creditsSource === "theintrodb").length },
      mostWatched: [...byTitle.values()].sort((a, b) => b.watchedMs - a.watchedMs).slice(0, TOP_TITLES),
      people: this.people(since, watched),
    };
  }

  /** Every account with what it asked for and watched, the busiest viewer first. */
  private people(since: number, watched: Array<{ userId: string; watchedMs: number }>): PersonStats[] {
    const requests = Analytics.requestsByUser(since);
    return Analytics.accounts()
      .map((account) => {
        const own = watched.filter((row) => row.userId === account.id);
        return {
          id: account.id,
          name: account.name,
          email: account.email,
          admin: account.role === "admin",
          requests: requests.get(account.id) ?? 0,
          items: own.length,
          watchedMs: own.reduce((sum, row) => sum + row.watchedMs, 0),
        };
      })
      .sort((a, b) => b.watchedMs - a.watchedMs || b.requests - a.requests);
  }
}
