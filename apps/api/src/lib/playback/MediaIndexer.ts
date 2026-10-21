/**
 * Keeps `media_items` in step with the library. When a download saves a
 * file, the indexer probes it in the background (streams, duration,
 * keyframes) and records it, so it can be played. When playback starts, or
 * is switched back on, it reconciles: files saved while it was off are
 * indexed, changed files are probed again, and files that are gone are
 * forgotten.
 *
 * Probing reads a whole file once, so files are done one at a time and never
 * hold up the download that saved them. Scrubbing thumbnails are made after
 * that, one file at a time, whenever no file is waiting to be indexed.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Download } from "../db/models/Download";
import { MediaItem } from "../db/models/MediaItem";
import { SettingsStore } from "../db/models/SettingsStore";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { ReleaseParser } from "../releases/ReleaseParser";
import { MediaProbe, PROBE_VERSION } from "./MediaProbe";
import { Trickplay } from "./Trickplay";

/** A file saved by a download, with the episodes it holds when the pipeline knows them. */
export interface SavedFile {
  path: string;
  episodes: number[];
}

/** One piece of work in the queue. */
type Task = { kind: "reconcile" } | { kind: "download"; downloadId: string; files: SavedFile[] | null };

export default class MediaIndexer extends SelfManagedSingleton {
  private running = false;
  private draining = false;
  private queue: Task[] = [];
  /** Items waiting for scrubbing thumbnails, done when the queue is empty. */
  private thumbnails: string[] = [];
  private controller: AbortController | null = null;
  private readonly probe = new MediaProbe();
  private readonly parser = new ReleaseParser();

  /** Starts indexing, beginning with a reconcile of the whole library. */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.push({ kind: "reconcile" });
  }

  /** Stops indexing and abandons the queue; the next start reconciles whatever was missed. */
  public stop(): void {
    this.running = false;
    this.queue = [];
    this.thumbnails = [];
    this.controller?.abort();
  }

  /**
   * Indexes what a download has saved. `files` carries the episodes of each
   * file when the caller knows them; otherwise they are read from file names.
   * Never throws, and does nothing while indexing is stopped.
   */
  public enqueue(downloadId: string, files: SavedFile[] | null = null): void {
    if (!this.running) return;
    this.push({ kind: "download", downloadId, files });
  }

  /** Queues thumbnails for every item without a current set, such as after their settings change. */
  public refreshThumbnails(): void {
    if (!this.running) return;
    for (const known of MediaItem.stamps()) this.queueThumbnails(known.id);
    void this.drain();
  }

  // ---------- Queue ---------- //

  private push(task: Task): void {
    this.queue.push(task);
    void this.drain();
  }

  /** Works through the queue one task at a time, then thumbnails while nothing else waits. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running) {
        const task = this.queue.shift();
        if (task) {
          try {
            if (task.kind === "reconcile") await this.reconcile();
            else await this.indexDownload(task.downloadId, task.files);
          } catch (error) {
            console.warn("[Playback] Indexing failed:", error instanceof Error ? error.message : error);
          }
          continue;
        }

        const itemId = this.thumbnails.shift();
        if (!itemId) break;
        await this.makeThumbnails(itemId);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Queues an item for thumbnails when they are on and it has none for the current settings. */
  private queueThumbnails(itemId: string): void {
    const settings = SettingsStore.section("playback");
    if (!settings.trickplay || Trickplay.root() === null) return;
    if (this.thumbnails.includes(itemId) || Trickplay.ready(itemId, settings)) return;
    this.thumbnails.push(itemId);
  }

  /** Makes one item's thumbnails, unless they were turned off or it went away meanwhile. */
  private async makeThumbnails(itemId: string): Promise<void> {
    const settings = SettingsStore.section("playback");
    const item = MediaItem.find(itemId);
    if (!item || !settings.trickplay || Trickplay.ready(itemId, settings)) return;

    this.controller = new AbortController();
    try {
      await Trickplay.generate(item, settings, this.controller.signal);
      if (!this.controller.signal.aborted) console.log(`[Playback] Made thumbnails for ${basename(item.path)}`);
    } catch (error) {
      console.warn(`[Playback] Could not make thumbnails for ${basename(item.path)}:`, error instanceof Error ? error.message : error);
    } finally {
      this.controller = null;
    }
  }

  // ---------- Work ---------- //

  /**
   * Forgets files that are gone, indexes every saved file not yet known or
   * changed since, then clears thumbnails of forgotten items and queues any
   * that are missing.
   */
  private async reconcile(): Promise<void> {
    for (const known of MediaItem.stamps()) {
      const current = await stat(known.path).catch(() => null);
      if (!current?.isFile()) {
        MediaItem.remove(known.id);
        await Trickplay.remove(known.id);
      }
    }
    for (const download of Download.withSavedFiles()) {
      if (!this.running) return;
      await this.indexDownload(download.id, null);
    }

    const known = MediaItem.stamps();
    await Trickplay.sweep(new Set(known.map((entry) => entry.id)));
    for (const entry of known) this.queueThumbnails(entry.id);
  }

  /** Indexes each file a download saved. */
  private async indexDownload(downloadId: string, files: SavedFile[] | null): Promise<void> {
    const download = Download.find(downloadId);
    if (!download) return;

    const hints = new Map((files ?? []).map((file) => [file.path, file.episodes]));
    for (const path of download.savedFiles) {
      if (!this.running) return;
      try {
        await this.indexFile(download, path, hints.get(path) ?? null);
      } catch (error) {
        console.warn(`[Playback] Could not index ${path}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  /** Probes one file and records it, unless it is already indexed as it is. */
  private async indexFile(download: Download, path: string, episodes: number[] | null): Promise<void> {
    const file = await stat(path).catch(() => null);
    if (!file?.isFile()) return;

    // Skip a file already indexed at this size and modification time, unless an older probe read it
    const mtime = Math.floor(file.mtimeMs);
    const known = MediaItem.findByPath(path);
    const unchanged = known !== null && known.size === file.size && known.mtime === mtime;
    if (unchanged && known.probe.version === PROBE_VERSION) return;

    // A season file needs an episode number; skip one that names none
    const { season, episode } = this.placement(download, path, episodes);
    if (download.mediaType === "tv" && episode === null) {
      console.warn(`[Playback] No episode number in ${basename(path)}; it can't be played`);
      return;
    }

    this.controller = new AbortController();
    const probe = await this.probe.probe(path, this.controller.signal);
    // An unchanged file keeps its keyframes, which only a full pass over it can read
    const keyframes = unchanged ? known.keyframes : await this.probe.keyframes(path, probe.startTime, this.controller.signal);
    this.controller = null;
    if (!this.running) return;

    const item = MediaItem.upsert({ titleId: download.titleId, downloadId: download.id, season, episode, path, size: file.size, mtime, probe, keyframes });
    console.log(`[Playback] Indexed ${basename(path)}`);

    // A changed file needs new thumbnails
    if (unchanged) return;
    await Trickplay.remove(item.id);
    this.queueThumbnails(item.id);
  }

  /** Which season and episode a file holds: from the pipeline when known, else from its name. */
  private placement(download: Download, path: string, episodes: number[] | null): { season: number | null; episode: number | null } {
    if (download.mediaType === "movie") return { season: null, episode: null };

    // Multi-episode files are filed under their first episode
    const known = episodes?.[0];
    if (known !== undefined) return { season: download.season, episode: known };

    const parsed = this.parser.parse(basename(path));
    return { season: parsed.seasons[0] ?? download.season, episode: parsed.episodes[0] ?? null };
  }
}
