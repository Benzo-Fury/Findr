/**
 * Owns every download's lifecycle: queueing, running up to the configured
 * concurrency, cancelling, retrying, deleting, and recovering after a restart.
 *
 * The queue itself is in memory, but it is always rebuilt from the database —
 * on startup every unfinished download is re-queued, so nothing depends on the
 * process staying up. Each running download holds an `AbortController`;
 * cancelling aborts it, and the runner cleans up and records the outcome.
 *
 * The queue follows the VPN killswitch. When the VPN goes down it cuts the
 * torrent client's connections at once; downloads mid-transfer stop with
 * their release put back and wait at the front of the queue, and nothing new
 * starts. When the VPN is back, the queue picks up where it left off. When
 * the killswitch is turned on, or the VPN comes back on a new address, the
 * client is rebuilt so every socket is bound to the VPN's current address.
 */

import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MediaType } from "@findr/types/media";
import type { VpnStatus } from "@findr/types/vpn";
import { Attempt } from "../db/models/Attempt";
import { Candidate } from "../db/models/Candidate";
import { Download } from "../db/models/Download";
import { Episode } from "../db/models/Episode";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import type { Downloader } from "../downloader/Downloader";
import { WebTorrentDownloader } from "../downloader/WebTorrentDownloader";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import VpnGuard from "../vpn/VpnGuard";
import { AttemptRunner } from "./AttemptRunner";
import { DownloadRunner } from "./DownloadRunner";

// ---------- Errors ---------- //

/** A request the queue refuses, with a code the API maps to a status. */
export class QueueError extends Error {
  constructor(
    public readonly code: "already_downloading" | "not_found" | "not_finished" | "candidate_not_found",
    message: string,
  ) {
    super(message);
  }
}

// ---------- Queue ---------- //

export default class DownloadQueue extends SelfManagedSingleton {
  private downloader: Downloader = new WebTorrentDownloader();
  private attempts = new AttemptRunner(this.downloader);

  /** Download ids waiting for a slot, oldest first. */
  private waiting: string[] = [];
  /** Running downloads and the controllers that cancel them. */
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor() {
    super();
    VpnGuard.getInstance().subscribe((status, previous) => this.onVpnChange(status, previous));
  }

  /** Swaps the torrent client backend. Used by tests; must be called before any download runs. */
  public useDownloader(downloader: Downloader): this {
    this.downloader = downloader;
    this.attempts = new AttemptRunner(downloader);
    return this;
  }

  /** Resolves once every running download has stopped. Used by tests and shutdown. */
  public async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()].map((entry) => entry.done));
  }

  // ---------- Commands ---------- //

  /**
   * Queues a download for a title, or refuses if the same title and season is
   * already underway.
   */
  public enqueue(tmdbId: number, mediaType: MediaType, season: number | null, requestedBy: string): Download {
    const title = Title.findOrCreate(tmdbId, mediaType);
    const existing = Download.findUnfinished(title.id, season);
    if (existing) throw new QueueError("already_downloading", "This title is already being downloaded");

    const download = Download.create(title, season, requestedBy);
    this.push(download.id);
    this.notePaused(download);
    return download;
  }

  /**
   * Stops a download. A running one is aborted and cleans up after itself; a
   * queued one is simply marked cancelled. Resolves once it has stopped.
   */
  public async cancel(id: string): Promise<Download> {
    const download = this.require(id);

    // Abort a running download and wait for its cleanup. One the killswitch
    // paused at the same moment is left queued, so cancel it as well
    const active = this.running.get(id);
    if (active) {
      active.controller.abort();
      await active.done;
      const stopped = this.require(id);
      if (stopped.isFinished) return stopped;
    }

    // A queued download never started, so there is nothing to clean up
    if (!download.isFinished) {
      this.waiting = this.waiting.filter((waiting) => waiting !== id);
      download.setStatus("cancelled", "Cancelled");
    }
    return download;
  }

  /**
   * Starts a finished download again as a new run. Failed and cancelled
   * episodes become pending, and when a candidate is given it is put back in
   * line ahead of everything else.
   */
  public retry(id: string, candidateId?: string): Download {
    const download = this.require(id);
    if (!download.isFinished) throw new QueueError("not_finished", "The download is still in progress");

    // Pin the chosen release, if any
    if (candidateId) {
      const candidate = Candidate.find(candidateId);
      if (!candidate || candidate.downloadId !== id) {
        throw new QueueError("candidate_not_found", "That release does not belong to this download");
      }
      candidate.requeue(true);
    }

    // Give unfinished episodes another go
    for (const episode of Episode.forDownload(id)) {
      if (episode.status === "failed" || episode.status === "cancelled") episode.setStatus("pending");
    }

    download.startNewRun();
    this.push(id);
    this.notePaused(download);
    return download;
  }

  /**
   * Removes a download and its history, cancelling it first if it is running.
   * Files already saved to the library are left alone.
   */
  public async remove(id: string): Promise<void> {
    const download = this.require(id);
    if (!download.isFinished) await this.cancel(id);

    await this.removeScratch(id);
    download.delete();
  }

  // ---------- Recovery ---------- //

  /**
   * Restores a consistent state after a restart and resumes work. Attempts
   * that were in flight when the process died are closed as interrupted, their
   * candidates rejected, their scratch directories deleted and their torrents
   * removed from the client. Every unfinished download is then re-queued.
   */
  public async recover(): Promise<void> {
    const downloadsRoot = SettingsStore.load().paths.downloads;

    // Close out attempts the previous process never finished
    for (const attempt of Attempt.unfinished()) {
      attempt.finish("interrupted", "Interrupted by a server restart");
      Candidate.find(attempt.candidateId)?.reject("Interrupted by a server restart");
      if (downloadsRoot && isAbsolute(downloadsRoot)) {
        await rm(join(downloadsRoot, attempt.downloadId, attempt.candidateId), { recursive: true, force: true });
      }
    }

    // Candidates marked attempting without an open attempt are stranded too
    for (const candidate of Candidate.stranded()) candidate.reject("Interrupted by a server restart");

    // Nothing is running yet, so every torrent this app added is a leftover
    try {
      for (const handle of (await this.downloader.managed()).values()) await this.downloader.remove(handle);
    } catch (error) {
      console.warn("[Queue] Could not sweep leftover torrents:", error instanceof Error ? error.message : error);
    }

    // Resume everything unfinished, oldest first
    const unfinished = Download.unfinished();
    for (const download of unfinished) {
      download.setStatus("queued", "Resumed after restart");
      this.push(download.id);
      this.notePaused(download);
    }
    console.log(`[Queue] Recovered; resuming ${unfinished.length} download(s)`);
  }

  // ---------- Killswitch ---------- //

  /**
   * Pauses everything when the VPN goes down, and resumes once it is allowed
   * again. A client started before the killswitch was turned on, or bound to
   * an address the VPN no longer has, is rebuilt: its transfers pause and
   * restart at once on the VPN's current address.
   */
  private onVpnChange(status: VpnStatus, previous: VpnStatus): void {
    const moved = previous.state === "up" && previous.addresses.join(",") !== status.addresses.join(",");
    const rebind = status.state === "up" && (previous.state === "off" || moved);
    if (status.state !== "down" && !rebind) {
      this.drain();
      return;
    }

    // Cut every torrent connection now; transfers notice on their next poll
    const reason = rebind ? "The torrent client is moving onto the VPN" : (status.reason ?? "The VPN is down");
    this.downloader.disconnect(reason).catch((error: unknown) => {
      console.error("[Queue] Could not disconnect the torrent client:", error instanceof Error ? error.message : error);
    });
    if (rebind) {
      this.drain();
      return;
    }

    // Say why the downloads that have not started are waiting
    for (const id of this.waiting) {
      const download = Download.find(id);
      if (download) this.notePaused(download);
    }
  }

  /** Marks a queued download as waiting for the VPN, while the killswitch holds traffic back. */
  private notePaused(download: Download): void {
    const vpn = VpnGuard.getInstance();
    if (download.status !== "queued" || vpn.allowed) return;
    download.setStatus("queued", DownloadRunner.pausedMessage(vpn.status.reason ?? "The VPN is down"));
  }

  // ---------- Scheduling ---------- //

  /** Adds a download to the back of the queue and starts whatever fits. */
  private push(id: string): void {
    if (!this.waiting.includes(id) && !this.running.has(id)) this.waiting.push(id);
    this.drain();
  }

  /** Starts queued downloads until the concurrency limit is reached, unless the killswitch holds them back. */
  private drain(): void {
    if (!VpnGuard.getInstance().allowed) return;
    const limit = SettingsStore.load().queue.maxConcurrent;

    while (this.running.size < limit && this.waiting.length > 0) {
      const id = this.waiting.shift();
      const download = id ? Download.find(id) : null;
      if (!id || !download || download.isFinished) continue;

      // Run it, then free the slot and start the next. A download the
      // killswitch paused is still unfinished and goes back to the front
      const controller = new AbortController();
      const runner = new DownloadRunner(download, this.attempts, controller.signal);
      const done = runner.run().finally(() => {
        this.running.delete(id);
        if (Download.find(id)?.isFinished === false && !this.waiting.includes(id)) this.waiting.unshift(id);
        this.drain();
      });
      this.running.set(id, { controller, done });
    }
  }

  // ---------- Helpers ---------- //

  private require(id: string): Download {
    const download = Download.find(id);
    if (!download) throw new QueueError("not_found", "Download not found");
    return download;
  }

  /** Deletes a download's scratch directory, if the downloads root is configured. */
  private async removeScratch(id: string): Promise<void> {
    const root = SettingsStore.load().paths.downloads;
    if (root && isAbsolute(root)) await rm(join(root, id), { recursive: true, force: true });
  }
}
