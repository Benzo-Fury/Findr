/**
 * Catches an attempt that has stopped doing anything at all. The work beats
 * whenever it shows a sign of life — a torrent poll coming back, a line of
 * mkvmerge progress, a chunk copied into the library — and if the beats stop
 * for longer than the limit, the attempt is declared stuck.
 *
 * This is deliberately not a progress check. A torrent crawling along or
 * waiting on seeders still answers every poll, and judging whether it will
 * finish is the torrent `Watchdog`'s job. The heartbeat only trips when a step
 * has hung outright: a client call that never returns, a remux that stopped
 * writing, a copy that froze.
 *
 * When it trips it aborts its signal, so cooperative work (sleeps, mkvmerge,
 * copies) stops, and rejects any work passed through `guard()` at once, so
 * even a promise that never settles cannot hold the attempt.
 */

import { AttemptFailure, CancelledError } from "./errors";

export interface HeartbeatOptions {
  /** How long the work may go without a beat before it counts as stuck. */
  limitMs: number;
  /** How often the silence is measured. Defaults to 15 s, or a quarter of a shorter limit. */
  checkEveryMs?: number;
}

const MINUTE = 60_000;
const DEFAULT_CHECK_MS = 15_000;

export class Heartbeat {
  private readonly controller = new AbortController();
  private readonly limitMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private lastBeatAt = Date.now();
  private stage = "starting";
  private reason: string | null = null;
  private stop: (error: Error) => void = () => {};

  /** Rejects once the attempt is cancelled or caught stuck; never resolves. */
  private readonly stopped = new Promise<never>((_, reject) => {
    this.stop = reject;
  });

  constructor(
    private readonly parent: AbortSignal,
    options: HeartbeatOptions,
  ) {
    this.limitMs = options.limitMs;
    this.stopped.catch(() => {});

    // Follow a cancellation from above
    if (parent.aborted) this.cancel();
    else parent.addEventListener("abort", this.cancel, { once: true });

    // Measure the silence on a fixed beat of our own
    this.timer = setInterval(() => this.check(), options.checkEveryMs ?? Math.min(DEFAULT_CHECK_MS, this.limitMs / 4));
    this.timer.unref?.();
  }

  /** Aborts when the parent does, or when the work is caught stuck. Hand this to the work. */
  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Why the work was declared stuck, or null while it is alive. */
  public get stuckReason(): string | null {
    return this.reason;
  }

  /** Records a sign of life. */
  public readonly beat = (): void => {
    this.lastBeatAt = Date.now();
  };

  /** Names the step now running, for the stuck message, and counts as a beat. */
  public enter(stage: string): void {
    this.stage = stage;
    this.beat();
  }

  /** Settles with the work, or rejects as soon as the attempt is cancelled or stuck. */
  public guard<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.stopped]);
  }

  /** Trips when the work has been silent past the limit. Runs on the timer; public for tests. */
  public check(now = Date.now()): void {
    if (this.controller.signal.aborted || now - this.lastBeatAt <= this.limitMs) return;

    // Reject guarded work before aborting, so the stuck reason wins the race
    this.reason = `Stuck: nothing happened while ${this.stage} for ${this.limitLabel()}`;
    this.stop(new AttemptFailure(this.reason));
    this.controller.abort();
  }

  /** Stops watching. Call once the guarded work has settled. */
  public dispose(): void {
    clearInterval(this.timer);
    this.parent.removeEventListener("abort", this.cancel);
  }

  private readonly cancel = (): void => {
    this.stop(new CancelledError());
    this.controller.abort();
  };

  private limitLabel(): string {
    const minutes = this.limitMs / MINUTE;
    return minutes >= 1 ? `${Number(minutes.toFixed(1))} min` : `${Math.round(this.limitMs / 1000)} s`;
  }
}
