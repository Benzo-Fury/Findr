/**
 * The four ways a unit of work can stop early. The distinction decides what
 * happens to the candidate being tried:
 *
 * - `AttemptFailure` — this release is bad (stalled, dangerous files, broken
 *   container). Reject it and move on to the next candidate.
 * - `FatalDownloadError` — the environment is broken (library paths unset,
 *   ffmpeg missing, a full disk: `OutOfSpaceError`). Trying another release would fail the same way, so
 *   stop without blaming the candidate.
 * - `SuspendedError` — the VPN killswitch cut torrent traffic. Put the
 *   candidate back and leave the download queued, to resume once the VPN is up.
 * - `CancelledError` — a user cancelled. Clean up and stop quietly.
 */

/** The current release cannot be used. Carries a reason worth showing a user. */
export class AttemptFailure extends Error {
  override readonly name = "AttemptFailure";
}

/** Something outside the release is wrong; no candidate can succeed until it is fixed. */
export class FatalDownloadError extends Error {
  override readonly name: string = "FatalDownloadError";
}

/**
 * A disk Findr writes to is too full for the attempt, or filled up during it.
 * Fatal, since every other release would need room too; the message says
 * which disk and what to do.
 */
export class OutOfSpaceError extends FatalDownloadError {
  override readonly name = "OutOfSpaceError";
}

/**
 * A write failed because a disk is full, raised where it happened (the
 * torrent engine, ffmpeg). The attempt runner turns it into an
 * `OutOfSpaceError` that names the step and the folder to clear; the
 * technical detail stays in the log.
 */
export class DiskFullError extends Error {
  override readonly name = "DiskFullError";
}

/** The VPN killswitch has stopped torrent traffic. Carries why the VPN counts as down. */
export class SuspendedError extends Error {
  override readonly name = "SuspendedError";
}

/** The download was cancelled while this work was in flight. */
export class CancelledError extends Error {
  override readonly name = "CancelledError";

  constructor() {
    super("Cancelled");
  }
}

/** Throws `CancelledError` if the signal has fired. Call between steps of long-running work. */
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

/** Resolves after `ms`, or rejects with `CancelledError` as soon as the signal fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    // Wake immediately on cancellation instead of sleeping out the interval
    function onAbort(): void {
      clearTimeout(timer);
      reject(new CancelledError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
