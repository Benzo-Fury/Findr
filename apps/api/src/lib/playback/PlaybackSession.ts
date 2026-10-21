/**
 * One person playing one library file on one device. The session owns a
 * scratch directory of segments and at most one ffmpeg run. A request for a
 * segment already written is answered from disk; one just ahead of the run
 * waits for it; anything further away restarts the run at that segment,
 * which is how seeking works.
 */

import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PlaybackDevice, PlaybackSettings } from "@findr/types/playback";
import type { MediaItem } from "../db/models/MediaItem";
import { HlsJob } from "./HlsJob";
import { HlsVariant } from "./HlsVariant";
import type { PlaybackPlan } from "./PlaybackDecider";
import { SegmentPlan } from "./SegmentPlan";


/** The media playlist's name beside the multivariant `index.m3u8`. */
export const MEDIA_PLAYLIST = "media.m3u8";

// ---------- Types ---------- //

/** Thrown to a waiting request whose segment will not come from the current run; the player retries. */
export class SegmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentUnavailableError";
  }
}

export interface SessionOptions {
  id: string;
  userId: string;
  item: MediaItem;
  plan: PlaybackPlan;
  settings: PlaybackSettings;
  directory: string;
  /** Where playback starts, in milliseconds. */
  startMs: number;
  audioLanguage: string | null;
  /** The browser playing it, or a cast receiver. */
  device: PlaybackDevice;
  /** Whether to start packaging before the first request; a cast session waits for its receiver. */
  warm: boolean;
}

/** A request waiting for a segment, or for the init section with index -1. */
interface Waiter {
  resolve(path: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Segments this close ahead of the run are waited for rather than restarting it. */
const WAIT_WINDOW = 3;

/** The longest a request waits for its segment. */
const WAIT_MS = 90_000;

/** Index used for the init section among the waiters. */
const INIT = -1;

// ---------- Session ---------- //

export class PlaybackSession {
  public readonly id: string;
  public readonly userId: string;
  public readonly item: MediaItem;
  public readonly plan: PlaybackPlan;
  public readonly segments: SegmentPlan;
  public readonly startMs: number;
  public readonly audioLanguage: string | null;
  public readonly device: PlaybackDevice;
  public readonly deviceName: string | null = null;
  public readonly warm: boolean;
  public readonly createdAt = Date.now();
  /** Last time the player fetched anything or reported progress. */
  public lastSeen = Date.now();
  /** Where the viewer is, from progress reports or, failing those, the segments asked for. */
  public positionMs: number;

  private readonly settings: PlaybackSettings;
  private readonly directory: string;
  private job: HlsJob | null = null;
  private initReady = false;
  private readonly ready = new Set<number>();
  private readonly waiters = new Map<number, Waiter[]>();
  private closed = false;
  private reportedAt = 0;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.userId = options.userId;
    this.item = options.item;
    this.plan = options.plan;
    this.settings = options.settings;
    this.directory = options.directory;
    this.startMs = options.startMs;
    this.audioLanguage = options.audioLanguage;
    this.device = options.device;
    this.warm = options.warm;
    this.positionMs = options.startMs;

    // Copied video cuts on its keyframes; encoded video places its own every segment length
    const duration = options.item.durationMs / 1000;
    this.segments =
      options.plan.video === "copy"
        ? SegmentPlan.fromKeyframes(options.item.keyframes, duration, options.settings.segmentSeconds)
        : SegmentPlan.fixed(duration, options.settings.segmentSeconds);
  }

  /** Whether the session encodes video, which counts toward the transcode limit. */
  public get transcoding(): boolean {
    return this.plan.video === "encode";
  }

  /** Starts packaging from where playback will begin, so the first segments are ready sooner. */
  public warmUp(): void {
    if (this.warm) this.restart(this.segments.indexAt(this.startMs / 1000));
  }

  /** The HLS multivariant playlist, naming the one media playlist and what it holds. */
  public multivariantPlaylist(): string {
    this.touch();
    return HlsVariant.playlist(this.item.probe, this.plan, MEDIA_PLAYLIST);
  }

  /** The HLS media playlist. */
  public playlist(): string {
    this.touch();
    return this.segments.playlist(this.startMs / 1000);
  }

  /** The init section's path, once the first run has produced it. */
  public async init(): Promise<string> {
    this.touch();
    if (this.initReady) return this.initPath;
    if (!this.job?.alive) this.restart(this.segments.indexAt(this.startMs / 1000));
    return this.wait(INIT);
  }

  /** A segment's path, produced first if need be. */
  public async segment(index: number): Promise<string> {
    if (index < 0 || index >= this.segments.count) throw new SegmentUnavailableError(`No segment ${index}`);
    this.touch();
    if (!this.reportedRecently) this.positionMs = Math.round(this.segments.start(index) * 1000);
    this.job?.setPlayhead(index);
    void this.prune(index);

    // Already on disk
    const path = this.segmentPath(index);
    if (this.ready.has(index) && existsSync(path)) return path;
    this.ready.delete(index);

    // Coming shortly from the current run, or restart the run there
    const job = this.job;
    const comingSoon = job?.alive && index >= job.producing && index <= job.producing + WAIT_WINDOW;
    if (!comingSoon) this.restart(index);
    return this.wait(index);
  }

  /** Marks the session as in use. */
  public touch(): void {
    this.lastSeen = Date.now();
  }

  /** Records where the player says it is. */
  public report(positionMs: number): void {
    this.touch();
    this.positionMs = positionMs;
    this.reportedAt = Date.now();
  }

  /** Whether the player has reported its position lately, which beats guessing from segments. */
  private get reportedRecently(): boolean {
    return Date.now() - this.reportedAt < 30_000;
  }

  /** Stops the run, fails every waiting request and deletes the scratch directory. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.job?.kill();
    this.job = null;
    this.rejectWaiters(() => true, "The session ended");
    await rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }

  // ---------- Runs ---------- //

  /** Replaces the current run with one starting at `index`. */
  private restart(index: number): void {
    if (this.closed) return;
    const previous = this.job;
    this.job = null;
    previous?.kill();

    const job = new HlsJob({
      path: this.item.path,
      plan: this.plan,
      segments: this.segments,
      settings: this.settings,
      startIndex: index,
      startTime: this.item.probe.startTime,
      directory: this.directory,
      onInit: (bytes) => void this.saveInit(bytes),
      onSegment: (segment) => {
        this.ready.add(segment);
        this.resolveWaiters(segment, this.segmentPath(segment));
      },
      onEnd: (error) => {
        // A run replaced by a seek ends quietly; its successor serves the waiters
        if (this.job !== job) return;
        this.job = null;
        if (error) console.warn(`[Playback] Session ${this.id} run failed: ${error.message}`);
        this.rejectWaiters(() => true, error?.message ?? "The run ended");
      },
    });
    this.job = job;

    // Requests this run won't reach should retry rather than wait out the timeout
    this.rejectWaiters((waiting) => waiting !== INIT && (waiting < index || waiting > index + WAIT_WINDOW), "Seeked elsewhere");
    job.start();
  }

  /** Keeps the first init section; later runs produce the same one. */
  private async saveInit(bytes: Uint8Array): Promise<void> {
    if (this.initReady) return;
    await Bun.write(this.initPath, bytes);
    this.initReady = true;
    this.resolveWaiters(INIT, this.initPath);
  }

  /** Deletes segments far enough behind the player. */
  private async prune(playhead: number): Promise<void> {
    const cutoff = this.segments.start(playhead) - this.settings.segmentKeepSeconds;
    if (cutoff <= 0) return;
    for (const index of [...this.ready]) {
      if (this.segments.start(index + 1) >= cutoff) continue;
      this.ready.delete(index);
      await unlink(this.segmentPath(index)).catch(() => {});
    }
  }

  // ---------- Waiting ---------- //

  /** Resolves once `index` (or the init section) is written. */
  private wait(index: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(index, waiter);
        reject(new SegmentUnavailableError(`Timed out waiting for segment ${index}`));
      }, WAIT_MS);
      const waiter: Waiter = { resolve, reject, timer };
      const list = this.waiters.get(index) ?? [];
      list.push(waiter);
      this.waiters.set(index, list);
    });
  }

  private resolveWaiters(index: number, path: string): void {
    for (const waiter of this.waiters.get(index) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve(path);
    }
    this.waiters.delete(index);
  }

  private rejectWaiters(matches: (index: number) => boolean, message: string): void {
    for (const [index, list] of this.waiters) {
      if (!matches(index)) continue;
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(new SegmentUnavailableError(message));
      }
      this.waiters.delete(index);
    }
  }

  private removeWaiter(index: number, waiter: Waiter): void {
    const list = this.waiters.get(index)?.filter((entry) => entry !== waiter) ?? [];
    if (list.length > 0) this.waiters.set(index, list);
    else this.waiters.delete(index);
  }

  // ---------- Paths ---------- //

  private get initPath(): string {
    return join(this.directory, "init.mp4");
  }

  private segmentPath(index: number): string {
    return join(this.directory, `${index}.m4s`);
  }
}
