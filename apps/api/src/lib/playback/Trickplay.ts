/**
 * Scrubbing thumbnails: sprite sheets of small frames taken every few
 * seconds, and a WebVTT storyboard saying which tile of which sheet shows
 * each moment. The player's time slider reads the storyboard to preview the
 * spot under the pointer.
 *
 * Thumbnails are kept beside the database, one folder per media item, with
 * a note of the interval and width they were made at; a folder made with
 * other settings is made again. Folders whose item is gone are swept away.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlaybackSettings } from "@findr/types/playback";
import { client } from "../db/client";
import type { MediaItem } from "../db/models/MediaItem";
import { env } from "../env/Env";
import { Ffmpeg, TRICKPLAY_TILE } from "./Ffmpeg";

/** What a folder of thumbnails was made with. */
interface TrickplayMeta {
  /** Bumped when the layout of a folder changes, so older ones are made again. */
  format: number;
  intervalSeconds: number;
  width: number;
}

/** The current folder layout. */
const FORMAT = 2;

export class Trickplay {
  /** Where every item's thumbnails live; null for an in-memory database. */
  public static root(): string | null {
    return client.directory ? join(client.directory, "trickplay") : null;
  }

  /** One item's folder. */
  public static directory(itemId: string): string | null {
    const root = this.root();
    return root ? join(root, itemId) : null;
  }

  /** Whether an item has thumbnails made with the current settings. */
  public static ready(itemId: string, settings: PlaybackSettings): boolean {
    const directory = this.directory(itemId);
    if (!directory || !existsSync(join(directory, "storyboard.vtt"))) return false;
    try {
      const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")) as TrickplayMeta;
      return meta.format === FORMAT && meta.intervalSeconds === settings.trickplayIntervalSeconds && meta.width === settings.trickplayWidth;
    } catch {
      return false;
    }
  }

  /**
   * The storyboard's URL when an item has current thumbnails, else null. It
   * names the version made, so a browser never shows a stale storyboard.
   */
  public static url(itemId: string, settings: PlaybackSettings): string | null {
    const directory = this.directory(itemId);
    if (!directory || !this.ready(itemId, settings)) return null;
    const made = Math.floor(statSync(join(directory, "storyboard.vtt")).mtimeMs);
    return `/api/playback/trickplay/${itemId}/storyboard.vtt?v=${made.toString(36)}`;
  }

  /**
   * Makes an item's thumbnails, replacing any made with other settings. The
   * sheets are written to a scratch folder and moved into place whole.
   * `directory` overrides where they go.
   */
  public static async generate(item: MediaItem, settings: PlaybackSettings, signal: AbortSignal, directory = this.directory(item.id)): Promise<void> {
    if (!directory) return;
    const scratch = `${directory}.part`;
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });

    try {
      // Tiles keep the picture's shape, at an even height
      const { width: sourceWidth, height: sourceHeight } = item.probe.video;
      const width = settings.trickplayWidth;
      const height = Math.max(2, Math.round((width * sourceHeight) / Math.max(sourceWidth, 1) / 2) * 2);
      const interval = settings.trickplayIntervalSeconds;

      const args = Ffmpeg.trickplayArgs(item.path, item.probe.video.index, scratch, {
        intervalSeconds: interval,
        width,
        height,
        toneMap: item.probe.video.hdr && settings.toneMapping,
      });
      const output = await Ffmpeg.run(env.FFMPEG_PATH, args, signal);
      if (signal.aborted) return;
      if (output.exitCode !== 0) throw new Error(output.stderr.trim().slice(-300) || `ffmpeg exited with ${output.exitCode}`);

      // One cue per thumbnail, pointing at its tile. Players resolve cue text against the page,
      // not the storyboard, so the sheets are named by their full path
      const sheets = `/api/playback/trickplay/${item.id}`;
      const count = Math.ceil(item.durationMs / 1000 / interval);
      const perSheet = TRICKPLAY_TILE * TRICKPLAY_TILE;
      const lines = ["WEBVTT", ""];
      for (let index = 0; index < count; index++) {
        const sheet = Math.floor(index / perSheet) + 1;
        const tile = index % perSheet;
        const x = (tile % TRICKPLAY_TILE) * width;
        const y = Math.floor(tile / TRICKPLAY_TILE) * height;
        const end = Math.min((index + 1) * interval, item.durationMs / 1000);
        lines.push(`${this.timestamp(index * interval)} --> ${this.timestamp(end)}`, `${sheets}/${sheet}.jpg#xywh=${x},${y},${width},${height}`, "");
      }
      await writeFile(join(scratch, "storyboard.vtt"), lines.join("\n"));
      await writeFile(join(scratch, "meta.json"), JSON.stringify({ format: FORMAT, intervalSeconds: interval, width } satisfies TrickplayMeta));

      await rm(directory, { recursive: true, force: true });
      await rename(scratch, directory);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Deletes an item's thumbnails. */
  public static async remove(itemId: string): Promise<void> {
    const directory = this.directory(itemId);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  /** Deletes folders, and half-made ones, belonging to items that no longer exist. */
  public static async sweep(knownIds: Set<string>): Promise<void> {
    const root = this.root();
    if (!root) return;
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const entry of entries) {
      if (knownIds.has(entry)) continue;
      await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** `HH:MM:SS.mmm`, as WebVTT writes times. */
  private static timestamp(seconds: number): string {
    const ms = Math.round(seconds * 1000);
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    const pad = (value: number, length = 2) => String(value).padStart(length, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms % 1000, 3)}`;
  }
}
