/**
 * Drives one torrent through a `Downloader` for one attempt: add it, wait for
 * its file list, inspect that list, download only the chosen files, and watch
 * the transfer until it completes or the watchdog gives up on it.
 *
 * A session owns its torrent. Whatever happens, the caller finishes with
 * `discard()`, which removes the torrent and its data from the client.
 */

import { join } from "node:path";
import type { WatchdogSettings } from "@findr/types/settings";
import { AttemptFailure, sleep, throwIfCancelled } from "../pipeline/errors";
import type { Downloader, TorrentInput } from "./Downloader";
import type { FileInspector, InspectionTarget, SelectedFile } from "./FileInspector";
import { Watchdog } from "./Watchdog";

// ---------- Types ---------- //

export interface FetchRequest {
  input: TorrentInput;
  /** Directory the client saves the payload into. */
  directory: string;
  /** Unique tag, so the torrent can be found again after a restart. */
  tag: string;
  target: InspectionTarget;
  signal: AbortSignal;
  /** Called when the payload transfer begins, after inspection passes. */
  onDownloadStart: () => void;
  /** Called with 0–1 progress on each poll while downloading. */
  onProgress: (progress: number) => void;
}

/** A selected file, now on disk. */
export interface FetchedFile extends SelectedFile {
  absolutePath: string;
}

// ---------- Session ---------- //

export class TorrentSession {
  /** The client's handle once the torrent has been added. */
  private handle: string | null = null;

  constructor(
    private readonly downloader: Downloader,
    private readonly inspector: FileInspector,
    private readonly watchdogSettings: WatchdogSettings,
  ) {}

  /** Runs the torrent to completion, returning the selected files on disk. */
  public async fetch(request: FetchRequest): Promise<FetchedFile[]> {
    const { signal } = request;
    const pollMs = this.watchdogSettings.pollIntervalSeconds * 1000;
    const watchdog = new Watchdog(this.watchdogSettings, Date.now());

    // Add the torrent paused at metadata
    this.handle = await this.downloader.add(request.input, { directory: request.directory, tag: request.tag });
    const handle = this.handle;

    // Wait for the file list, under the metadata timeout
    let files = await this.downloader.files(handle);
    while (!files) {
      throwIfCancelled(signal);
      this.trip(watchdog.check({ at: Date.now(), phase: "metadata", downloadedBytes: 0 }));
      await sleep(pollMs, signal);
      files = await this.downloader.files(handle);
    }

    // Decide what to fetch before a single payload byte arrives
    const inspection = this.inspector.inspect(files, request.target);
    if (!inspection.accepted) throw new AttemptFailure(inspection.reason);

    // Download only the chosen files
    await this.downloader.start(handle, inspection.files.map((file) => file.index));
    request.onDownloadStart();

    // Poll until complete, letting the watchdog abandon a dying transfer
    while (true) {
      throwIfCancelled(signal);
      const status = await this.downloader.status(handle);
      if (!status) throw new AttemptFailure("The torrent was removed from the download client");
      if (status.state === "error") throw new AttemptFailure(status.error ?? "The download client reported an error");
      if (status.state === "complete") break;

      request.onProgress(status.progress);
      if (status.state === "downloading") {
        this.trip(watchdog.check({ at: Date.now(), phase: "downloading", downloadedBytes: status.downloadedBytes }));
      }
      await sleep(pollMs, signal);
    }

    // Stop seeding so nothing touches the files while they are processed
    await this.downloader.stop(handle);
    request.onProgress(1);

    return inspection.files.map((file) => ({ ...file, absolutePath: join(request.directory, file.path) }));
  }

  /** Removes the torrent and its data from the client. Never throws; cleanup is best effort. */
  public async discard(): Promise<void> {
    if (!this.handle) return;
    await this.downloader.remove(this.handle).catch((error: unknown) => {
      console.warn(`[Downloader] Could not remove torrent ${this.handle}:`, error);
    });
    this.handle = null;
  }

  /** Turns a watchdog verdict into an attempt failure. */
  private trip(reason: string | null): void {
    if (reason) throw new AttemptFailure(reason);
  }
}
