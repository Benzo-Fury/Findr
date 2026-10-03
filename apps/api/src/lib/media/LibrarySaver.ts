/**
 * Moves sterilized files into the media library under the configured naming
 * templates — `Movies/Title (Year)/Title (Year).mkv` or
 * `TV/Title (Year)/Season 01/Title - S01E01.mkv` by default.
 *
 * Every file lands atomically. It is first placed under a hidden temporary
 * name inside the destination directory, then renamed into place; a rename
 * within one directory is atomic, so the library never shows a half-written
 * file, and a failure part-way leaves nothing behind but a cleaned-up temp.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MediaType } from "@findr/types/media";
import type { NamingSettings, PathsSettings } from "@findr/types/settings";
import { CancelledError, FatalDownloadError, throwIfCancelled } from "../pipeline/errors";

// ---------- Types ---------- //

/** The TMDB facts the naming templates draw on. */
export interface TitleNaming {
  title: string;
  /** Four-digit year, or empty when TMDB has none. */
  year: string;
}

/** A sterilized file ready to be saved. */
export interface SaveItem {
  /** Absolute path of the sterilized file. */
  source: string;
  /** Episodes the file holds; empty for movies. */
  episodes: number[];
}

export interface SaveRequest {
  mediaType: MediaType;
  naming: TitleNaming;
  /** Series only. */
  season: number | null;
  items: SaveItem[];
}

/** Optional hooks for following and stopping a save. */
export interface SaveOptions {
  /** Stops a copy part-way; nothing reaches the library once it fires. */
  signal?: AbortSignal;
  /** Called with 0–1 across every item as bytes land. */
  onProgress?: (progress: number) => void;
}

/** Characters illegal on macOS, Linux or Windows filesystems. */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]+/g;

const EXTENSION = ".mkv";

/** Read and write in large chunks; library files run to gigabytes. */
const COPY_CHUNK_BYTES = 1024 * 1024;

// ---------- Saver ---------- //

export class LibrarySaver {
  constructor(
    private readonly paths: PathsSettings,
    private readonly templates: NamingSettings,
  ) {}

  /** Saves every item, returning the final library paths in the same order. */
  public async save(request: SaveRequest, options: SaveOptions = {}): Promise<string[]> {
    const directory = this.destinationDirectory(request);
    await mkdir(directory, { recursive: true });

    // Weigh the items so progress runs across all of them
    const sizes = await Promise.all(request.items.map(async (item) => (await stat(item.source)).size));
    const total = Math.max(sizes.reduce((sum, size) => sum + size, 0), 1);
    let placed = 0;
    const report = (bytes: number) => {
      placed += bytes;
      options.onProgress?.(placed / total);
    };

    // Place each file atomically; stop at the first failure
    const saved: string[] = [];
    for (const [index, item] of request.items.entries()) {
      const target = join(directory, this.fileName(request, item) + EXTENSION);
      const moved = await this.placeAtomically(item.source, target, options.signal, report);
      if (moved) report(sizes[index] ?? 0);
      saved.push(target);
    }
    return saved;
  }

  // ---------- Paths ---------- //

  /** The folder a title's files go in, per the naming templates. */
  private destinationDirectory(request: SaveRequest): string {
    const values = { title: request.naming.title, year: request.naming.year };

    // Movies get one folder per title
    if (request.mediaType === "movie") {
      return join(this.requireRoot(this.paths.movies, "movies"), this.render(this.templates.movieFolder, values));
    }

    // Series nest a season folder under the show folder
    const season = this.pad(request.season ?? 0);
    return join(
      this.requireRoot(this.paths.series, "series"),
      this.render(this.templates.seriesFolder, values),
      this.render(this.templates.seasonFolder, { season }),
    );
  }

  /**
   * A file's base name. Multi-episode files render their episode token as a
   * range (`01-E02`), which the default template turns into `S01E01-E02` —
   * the form Plex and Jellyfin recognise.
   */
  private fileName(request: SaveRequest, item: SaveItem): string {
    const values = { title: request.naming.title, year: request.naming.year };
    if (request.mediaType === "movie") return this.render(this.templates.movieFile, values);

    const episode = item.episodes.map((number) => this.pad(number)).join("-E");
    return this.render(this.templates.seriesFile, { ...values, season: this.pad(request.season ?? 0), episode });
  }

  /** Fails the download when a library root has not been configured. */
  private requireRoot(root: string, name: string): string {
    if (!root) throw new FatalDownloadError(`The ${name} library directory is not configured — set it in Settings`);
    return root;
  }

  // ---------- Placement ---------- //

  /**
   * Moves `source` to `target` without ever exposing a partial file at
   * `target`. A same-filesystem move is a metadata-only rename; across
   * filesystems the bytes are copied to the temp name first, reporting each
   * chunk to `onBytes`. Returns true for a rename, false for a copy.
   */
  private async placeAtomically(
    source: string,
    target: string,
    signal: AbortSignal | undefined,
    onBytes: (bytes: number) => void,
  ): Promise<boolean> {
    const temporary = join(target, "..", `.${Bun.randomUUIDv7()}.findr-partial`);

    try {
      // Stage the file under the temp name in the destination directory
      let moved = true;
      try {
        await rename(source, temporary);
      } catch (error) {
        if (!this.isCrossDevice(error)) throw error;
        await this.copy(source, temporary, signal, onBytes);
        moved = false;
      }

      // Swap it into place in one atomic step, unless the save was stopped meanwhile
      if (signal) throwIfCancelled(signal);
      await rename(temporary, target);
      return moved;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** Copies a file chunk by chunk, so a long copy can be followed and stopped. */
  private async copy(
    source: string,
    destination: string,
    signal: AbortSignal | undefined,
    onBytes: (bytes: number) => void,
  ): Promise<void> {
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        onBytes(chunk.length);
        done(null, chunk);
      },
    });

    try {
      await pipeline(
        createReadStream(source, { highWaterMark: COPY_CHUNK_BYTES }),
        counter,
        createWriteStream(destination, { highWaterMark: COPY_CHUNK_BYTES }),
        { signal },
      );
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      throw error;
    }
  }

  private isCrossDevice(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EXDEV";
  }

  // ---------- Templates ---------- //

  /** Fills `{token}` placeholders and strips characters no filesystem allows. */
  private render(template: string, values: Record<string, string>): string {
    const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
    const cleaned = filled.replace(ILLEGAL_CHARACTERS, "").replace(/\s+/g, " ").replace(/\(\s*\)/g, "").trim();
    return cleaned.replace(/[. ]+$/, "") || "Untitled";
  }

  private pad(value: number): string {
    return String(value).padStart(2, "0");
  }
}
