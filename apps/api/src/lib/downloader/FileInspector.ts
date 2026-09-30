/**
 * Looks at a torrent's file list — before any payload is downloaded — and
 * decides whether it is safe and useful, and which files to fetch.
 *
 * Rejects torrents carrying executables or scripts, and archive-only releases
 * with no playable video, which are a common malware vector. For accepted
 * torrents it picks exactly the video files the download needs, so samples,
 * extras and junk are never fetched.
 */

import { basename, extname } from "node:path";
import { ReleaseParser } from "../releases/ReleaseParser";
import type { TorrentFile } from "./Downloader";

// ---------- Rules ---------- //

/** Anything executable or scriptable. One of these anywhere rejects the whole torrent. */
const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".scr", ".lnk", ".bat", ".cmd", ".ps1", ".msi", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".hta", ".pif", ".com", ".jar", ".dll", ".apk", ".app", ".dmg",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".ts", ".m2ts", ".webm", ".mpg", ".mpeg", ".vob", ".flv",
]);

const ARCHIVE_EXTENSIONS = new Set([".rar", ".zip", ".7z", ".tar", ".gz", ".iso"]);

/** Sample clips are named or foldered as such and are always small. */
const SAMPLE_PATTERN = /(^|[\\/._ -])sample([\\/._ -]|$)/i;

/** A "movie" smaller than this is a sample, trailer or fake. */
const MIN_FEATURE_BYTES = 100 * 1024 * 1024;

// ---------- Types ---------- //

/** What the torrent must contain for the download to be satisfied. */
export type InspectionTarget =
  | { kind: "movie" }
  | { kind: "season"; season: number; requiredEpisodes: number[] }
  | { kind: "episode"; season: number; episode: number };

/** A file chosen for download, with the episodes it holds when the target is a series. */
export interface SelectedFile {
  index: number;
  path: string;
  /** Empty for movies. More than one for multi-episode files. */
  episodes: number[];
}

export type InspectionResult =
  | { accepted: true; files: SelectedFile[] }
  | { accepted: false; reason: string };

// ---------- Inspector ---------- //

export class FileInspector {
  private readonly parser = new ReleaseParser();

  /** Accepts or rejects a torrent from its file list alone. */
  public inspect(files: TorrentFile[], target: InspectionTarget): InspectionResult {
    // Refuse anything executable outright
    const dangerous = files.find((file) => DANGEROUS_EXTENSIONS.has(this.extension(file)));
    if (dangerous) return { accepted: false, reason: `Contains a blocked file type: ${basename(dangerous.path)}` };

    // Keep full-length videos only, ignoring samples
    const videos = files.filter(
      (file) => VIDEO_EXTENSIONS.has(this.extension(file)) && !SAMPLE_PATTERN.test(file.path),
    );

    // Archive-only releases are rejected, not unpacked
    if (videos.length === 0) {
      const archived = files.some((file) => ARCHIVE_EXTENSIONS.has(this.extension(file)));
      return { accepted: false, reason: archived ? "Archive-only release with no video file" : "No video files" };
    }

    switch (target.kind) {
      case "movie":
        return this.selectMovie(videos);
      case "season":
        return this.selectSeason(videos, target.season, target.requiredEpisodes);
      case "episode":
        return this.selectEpisode(videos, target.season, target.episode);
    }
  }

  // ---------- Targets ---------- //

  /** The largest video is the feature; anything too small to be one fails. */
  private selectMovie(videos: TorrentFile[]): InspectionResult {
    const largest = this.largest(videos);
    if (largest.sizeBytes < MIN_FEATURE_BYTES) {
      return { accepted: false, reason: "No full-length video (largest file is under 100 MB)" };
    }
    return { accepted: true, files: [{ index: largest.index, path: largest.path, episodes: [] }] };
  }

  /**
   * Maps each file to the episodes its name says it holds, then requires every
   * aired episode to be present. When one episode appears more than once, the
   * largest copy wins.
   */
  private selectSeason(videos: TorrentFile[], season: number, required: number[]): InspectionResult {
    // Index files by the episodes they cover, largest copy first
    const byEpisode = new Map<number, { file: TorrentFile; episodes: number[] }>();
    for (const file of [...videos].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
      const parsed = this.parser.parse(basename(file.path));
      if (parsed.kind !== "episode" || parsed.seasons[0] !== season) continue;

      for (const episode of parsed.episodes) {
        if (!byEpisode.has(episode)) byEpisode.set(episode, { file, episodes: parsed.episodes });
      }
    }

    // Every aired episode must be in the pack
    const missing = required.filter((episode) => !byEpisode.has(episode));
    if (missing.length > 0) {
      const list = missing.map((episode) => `E${String(episode).padStart(2, "0")}`).join(", ");
      return { accepted: false, reason: `Incomplete season pack: missing ${list}` };
    }

    // One selection per file, even when a file covers several episodes
    const selected = new Map<number, SelectedFile>();
    for (const episode of required) {
      const entry = byEpisode.get(episode);
      if (entry && !selected.has(entry.file.index)) {
        selected.set(entry.file.index, { index: entry.file.index, path: entry.file.path, episodes: entry.episodes });
      }
    }
    return { accepted: true, files: [...selected.values()] };
  }

  /** The file named for the episode, or the only video when the release holds just one. */
  private selectEpisode(videos: TorrentFile[], season: number, episode: number): InspectionResult {
    // Prefer an explicitly named match
    const named = videos.filter((file) => {
      const parsed = this.parser.parse(basename(file.path));
      return parsed.kind === "episode" && parsed.seasons[0] === season && parsed.episodes.includes(episode);
    });
    if (named.length > 0) {
      const file = this.largest(named);
      return { accepted: true, files: [{ index: file.index, path: file.path, episodes: [episode] }] };
    }

    // A single unnamed video in an episode release is that episode
    if (videos.length === 1 && videos[0]) {
      return { accepted: true, files: [{ index: videos[0].index, path: videos[0].path, episodes: [episode] }] };
    }

    return { accepted: false, reason: `No file for S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` };
  }

  // ---------- Helpers ---------- //

  private extension(file: TorrentFile): string {
    return extname(file.path).toLowerCase();
  }

  /** The biggest file of a non-empty list. */
  private largest(files: TorrentFile[]): TorrentFile {
    return files.reduce((best, file) => (file.sizeBytes > best.sizeBytes ? file : best));
  }
}
