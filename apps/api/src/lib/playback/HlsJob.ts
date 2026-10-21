/**
 * One ffmpeg run that packages a library file from a given segment onwards.
 * It reads ffmpeg's fragmented-MP4 output, groups the fragments into the
 * segments the session's plan laid out, and writes each finished segment to
 * the session directory under a temporary name before renaming it, so a
 * segment on disk is always whole.
 *
 * When throttling is on the job stops reading once it is far enough ahead of
 * the player. ffmpeg then blocks on its full output pipe, which pauses it
 * without signals. A run that produces nothing for a minute while not paused
 * is killed as stuck.
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PlaybackSettings } from "@findr/types/playback";
import { env } from "../env/Env";
import { Ffmpeg } from "./Ffmpeg";
import { Fmp4Splitter, type Fragment } from "./Fmp4Splitter";
import type { PlaybackPlan } from "./PlaybackDecider";
import type { SegmentPlan } from "./SegmentPlan";

// ---------- Types ---------- //

export interface HlsJobOptions {
  path: string;
  plan: PlaybackPlan;
  segments: SegmentPlan;
  settings: PlaybackSettings;
  /** The segment the run starts at. */
  startIndex: number;
  /** The file's first timestamp in seconds, which segment times are measured from. */
  startTime: number;
  /** Where segments are written. */
  directory: string;
  onInit(bytes: Uint8Array): void;
  onSegment(index: number): void;
  /** Called once when the run ends; `error` is null when it reached the end of the file. */
  onEnd(error: Error | null): void;
}

/** A run producing nothing for this long, while not paused, is stuck. */
const STALL_MS = 60_000;

/**
 * A fragment stamped this close before a cut still belongs after it: decode
 * times run ahead of presentation by the B-frame delay.
 */
const CUT_TOLERANCE = 0.5;

// ---------- Job ---------- //

export class HlsJob {
  public readonly startIndex: number;
  /** The segment being assembled now. */
  private currentIndex: number;
  private parts: Uint8Array[] = [];
  /** The latest segment the player asked for. */
  private playhead: number;
  private child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | null = null;
  private killed = false;
  private ended = false;
  private paused = false;
  private lastActivity = Date.now();
  private resumeReading: (() => void) | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether a video fragment has arrived; audio before the first one is dropped. */
  private seenVideo = false;

  constructor(private readonly options: HlsJobOptions) {
    this.startIndex = options.startIndex;
    this.currentIndex = options.startIndex;
    this.playhead = options.startIndex;
  }

  /** Whether the run is still producing. */
  public get alive(): boolean {
    return !this.ended && !this.killed;
  }

  /** The segment the run will finish next. */
  public get producing(): number {
    return this.currentIndex;
  }

  /** Launches ffmpeg and starts reading its output. */
  public start(): void {
    const { path, plan, segments, settings } = this.options;
    const args = Ffmpeg.streamArgs(path, plan, segments.start(this.startIndex), settings);

    try {
      this.child = Bun.spawn([env.FFMPEG_PATH, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      this.finish(new Error(`ffmpeg could not start: ${error instanceof Error ? error.message : error}`));
      return;
    }

    // Watch for a run that has gone quiet without being paused
    this.stallTimer = setInterval(() => {
      if (!this.paused && Date.now() - this.lastActivity > STALL_MS) this.kill(new Error("ffmpeg stopped producing output"));
    }, STALL_MS / 4);
    this.stallTimer.unref?.();

    void this.pump(this.child);
  }

  /** Tells the run where the player is, so a paused run can carry on. */
  public setPlayhead(index: number): void {
    this.playhead = index;
    if (this.resumeReading && !this.tooFarAhead()) {
      this.resumeReading();
      this.resumeReading = null;
    }
  }

  /** Stops the run and discards the segment it was assembling. */
  public kill(error: Error | null = null): void {
    if (!this.alive) return;
    this.killed = true;
    this.child?.kill("SIGKILL");
    this.resumeReading?.();
    this.finish(error);
  }

  // ---------- Output ---------- //

  /** Reads ffmpeg's output until it ends or the run is killed. */
  private async pump(child: NonNullable<typeof this.child>): Promise<void> {
    const stderr = new Response(child.stderr).text();
    let failure: Error | null = null;

    // Group fragments into segments as they arrive
    const pending: Fragment[] = [];
    // Runs keep the file's timestamps, which segment times measure from its first
    const splitter = new Fmp4Splitter(
      { onInit: (bytes) => this.options.onInit(bytes), onFragment: (fragment) => pending.push(fragment) },
      -this.options.startTime,
    );

    try {
      const reader = child.stdout.getReader();
      for (;;) {
        // Hold off while far enough ahead of the player
        while (this.alive && this.tooFarAhead()) {
          this.paused = true;
          await new Promise<void>((resolve) => (this.resumeReading = resolve));
        }
        this.paused = false;
        if (!this.alive) break;

        const { done, value } = await reader.read();
        if (done) break;
        this.lastActivity = Date.now();
        splitter.push(value);
        for (const fragment of pending.splice(0)) await this.add(fragment);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    if (this.killed) return;

    // A clean exit closes the last segment; anything else is a failure
    const exitCode = await child.exited;
    if (!failure && exitCode !== 0) failure = new Error(`ffmpeg exited with ${exitCode}: ${(await stderr).trim().slice(-500)}`);
    if (!failure && this.parts.length > 0) await this.write(this.currentIndex);
    this.finish(failure);
  }

  /**
   * Adds a fragment to its segment, writing out the previous segment when a
   * new one begins. A copied run starts on the keyframe before the one asked
   * for, so fragments ahead of its first segment are dropped, as is audio
   * before the first video.
   */
  private async add(fragment: Fragment): Promise<void> {
    if (fragment.time !== null) this.seenVideo = true;
    if (!this.seenVideo) return;
    const index = fragment.time === null ? this.currentIndex : this.options.segments.indexAt(fragment.time, CUT_TOLERANCE);
    if (index < this.startIndex) return;
    if (index > this.currentIndex) {
      if (this.parts.length > 0) await this.write(this.currentIndex);
      this.currentIndex = index;
    }
    this.parts.push(fragment.bytes);
  }

  /** Writes the assembled segment whole, then announces it. */
  private async write(index: number): Promise<void> {
    const parts = this.parts;
    this.parts = [];
    if (this.killed) return;

    const target = join(this.options.directory, `${index}.m4s`);
    const temporary = `${target}.part`;
    await Bun.write(temporary, new Blob(parts as Uint8Array<ArrayBuffer>[]));
    await rename(temporary, target);
    this.options.onSegment(index);
  }

  /** Whether the run has got far enough ahead to pause. */
  private tooFarAhead(): boolean {
    if (!this.options.settings.throttleTranscodes) return false;
    const aheadSeconds = this.options.segments.start(this.currentIndex) - this.options.segments.start(this.playhead);
    return aheadSeconds > this.options.settings.throttleAheadSeconds;
  }

  /** Ends the run once, reporting how. */
  private finish(error: Error | null): void {
    if (this.ended) return;
    this.ended = true;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.options.onEnd(error);
  }
}
