/**
 * Decides when a torrent is not going to finish and should be abandoned for
 * the next candidate. Fed one status sample per poll; stateless apart from
 * the samples it has seen, so it is trivially testable with fake clocks.
 *
 * Three independent tripwires, all from the watchdog settings:
 * - metadata: a magnet that never resolves its file list,
 * - stall: no new bytes at all for too long,
 * - speed: a download that trickles along below the minimum average rate.
 */

import type { WatchdogSettings } from "@findr/types/settings";

/** The parts of a status sample the watchdog reads. */
export interface WatchdogSample {
  /** Epoch milliseconds when the sample was taken. */
  at: number;
  phase: "metadata" | "downloading";
  downloadedBytes: number;
}

const MINUTE = 60_000;

export class Watchdog {
  /** When the metadata wait began. */
  private readonly startedAt: number;
  /** When the payload download began, once it has. */
  private downloadStartedAt: number | null = null;
  /** The last time the byte count went up. */
  private lastProgressAt: number | null = null;
  private lastBytes = 0;
  /** Recent samples inside the speed window, oldest first. */
  private window: Array<{ at: number; bytes: number }> = [];

  constructor(
    private readonly settings: WatchdogSettings,
    startedAt: number,
  ) {
    this.startedAt = startedAt;
  }

  /** Records a sample and returns why the torrent should be abandoned, or null to keep going. */
  public check(sample: WatchdogSample): string | null {
    // Waiting for the file list
    if (sample.phase === "metadata") {
      const waited = sample.at - this.startedAt;
      return waited > this.settings.metadataTimeoutMinutes * MINUTE
        ? `No metadata after ${this.settings.metadataTimeoutMinutes} min`
        : null;
    }

    // First downloading sample starts the stall and speed clocks
    if (this.downloadStartedAt === null) {
      this.downloadStartedAt = sample.at;
      this.lastProgressAt = sample.at;
      this.lastBytes = sample.downloadedBytes;
    }

    // Any new bytes reset the stall clock
    if (sample.downloadedBytes > this.lastBytes) {
      this.lastBytes = sample.downloadedBytes;
      this.lastProgressAt = sample.at;
    }

    return this.stallReason(sample.at) ?? this.speedReason(sample);
  }

  /** Trips when no byte has arrived for the stall timeout. */
  private stallReason(now: number): string | null {
    const idle = now - (this.lastProgressAt ?? now);
    return idle > this.settings.stallTimeoutMinutes * MINUTE
      ? `Stalled: no data received for ${this.settings.stallTimeoutMinutes} min`
      : null;
  }

  /**
   * Trips when the average rate over a full speed window is below the floor.
   * Only judged once a whole window has elapsed, so slow starts get a chance.
   */
  private speedReason(sample: WatchdogSample): string | null {
    if (this.settings.minSpeedKBps <= 0 || this.downloadStartedAt === null) return null;

    // Slide the window forward, keeping one sample at or before its start
    const windowMs = this.settings.speedWindowMinutes * MINUTE;
    this.window.push({ at: sample.at, bytes: sample.downloadedBytes });
    while (this.window.length > 1 && (this.window[1]?.at ?? Infinity) <= sample.at - windowMs) {
      this.window.shift();
    }

    // Not enough history yet to judge
    const oldest = this.window[0];
    if (!oldest || sample.at - this.downloadStartedAt < windowMs || sample.at - oldest.at < windowMs) return null;

    // Average rate across the window
    const kbps = (sample.downloadedBytes - oldest.bytes) / 1024 / ((sample.at - oldest.at) / 1000);
    return kbps < this.settings.minSpeedKBps
      ? `Too slow: averaged ${kbps.toFixed(1)} KB/s over ${this.settings.speedWindowMinutes} min (minimum ${this.settings.minSpeedKBps})`
      : null;
  }
}
