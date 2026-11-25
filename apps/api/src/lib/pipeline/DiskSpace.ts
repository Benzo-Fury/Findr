/**
 * Keeps attempts from starting on a disk that cannot hold them, and recognises
 * a disk that filled up anyway.
 *
 * An attempt peaks at about twice its release on the downloads disk: the
 * torrent payload and the sterilized copy sit side by side until the save.
 * When the library is on another disk, the save copies the files there as
 * well, so that disk needs one more release's worth. `reserve` checks both
 * before the first payload byte is requested, keeping a margin free for
 * everything else on the machine.
 *
 * Attempts run side by side, so each reservation stands until its attempt
 * ends, and later checks subtract what earlier ones still have to write. On
 * the downloads disk that is what the attempt's workspace does not hold yet,
 * measured in allocated blocks (torrent files are sparse); on the library disk
 * it is the whole release, until the attempt finishes. Checks run one at a
 * time, so two attempts never both count the same free bytes.
 *
 * Something outside Findr can still fill the disk mid-attempt, so every step
 * that writes also turns a "no space" error into `OutOfSpaceError`, which
 * stops the download without blaming the release.
 */

import { readdir, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DiskFullError, OutOfSpaceError } from "./errors";

// ---------- Types ---------- //

/** A filesystem, as far as a reservation is concerned. */
export interface Volume {
  /** Device id, equal for every path on the same filesystem. */
  device: number;
  /** Bytes an unprivileged process may still write. */
  freeBytes: number;
}

/** Reads volumes and disk usage. Swapped out in tests for a disk of any size. */
export interface VolumeProbe {
  /** The volume holding `path`, or its nearest existing parent; null when none can be read. */
  volume(path: string): Promise<Volume | null>;
  /** Bytes actually allocated under `path`, counting sparse files by their blocks. Zero when missing. */
  allocated(path: string): Promise<number>;
}

/** What one attempt is about to write. */
export interface SpaceRequest {
  /** The downloads root, named in a refusal. */
  downloads: string;
  /** The attempt's workspace root, under the downloads root. */
  workspace: string;
  /** The library root the files are saved under. Empty when unset, which the saver reports itself. */
  library: string;
  /** Total size of the files selected from the release. */
  bytes: number;
}

/** A held reservation. Release it once the attempt ends, however it ends. */
export interface SpaceReservation {
  release(): void;
}

/** One attempt's standing claim on the disks. */
interface Claim {
  workspace: string;
  scratchDevice: number;
  /** Bytes the workspace still needed when the claim was made, beyond what it already held. */
  scratchBytes: number;
  /** What the workspace held when the claim was made. */
  scratchBaseline: number;
  /** Library device, when the library is on another disk; null otherwise. */
  libraryDevice: number | null;
  libraryBytes: number;
}

// ---------- Constants ---------- //

const GIB = 1024 ** 3;

/** Left free on every disk an attempt writes to, for the database, logs and everything else on the machine. */
export const HEADROOM_BYTES = GIB;

/** Error codes and messages that mean the disk (or the user's quota on it) is full. */
const NO_SPACE_CODES = new Set(["ENOSPC", "EDQUOT"]);
const NO_SPACE_TEXT = /no space left on device|disk quota exceeded|ENOSPC|EDQUOT/i;

// ---------- Probe ---------- //

/** Reads the real filesystem. */
export class StatfsProbe implements VolumeProbe {
  public async volume(path: string): Promise<Volume | null> {
    // Walk up to the nearest directory that exists; a library folder may not yet
    let current = resolve(path);
    while (true) {
      const info = await Promise.all([statfs(current), stat(current)]).catch(() => null);
      if (info) return { device: info[1].dev, freeBytes: info[0].bavail * info[0].bsize };
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  public async allocated(path: string): Promise<number> {
    const info = await stat(path).catch(() => null);
    if (!info) return 0;
    if (!info.isDirectory()) return info.blocks * 512;

    // Sum every file below, by blocks, so sparse torrent files count what they hold
    const entries = await readdir(path, { recursive: true }).catch(() => [] as string[]);
    let total = 0;
    for (const entry of entries) {
      const file = await stat(join(path, entry)).catch(() => null);
      if (file?.isFile()) total += file.blocks * 512;
    }
    return total;
  }
}

// ---------- Disk space ---------- //

export class DiskSpace {
  /** Reservations of attempts still running. */
  private readonly claims = new Set<Claim>();
  /** The check in progress; the next one waits for it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly probe: VolumeProbe = new StatfsProbe(),
    private readonly headroom = HEADROOM_BYTES,
  ) {}

  /**
   * Reserves room for an attempt, or throws `OutOfSpaceError` explaining
   * which disk is short and by how much. A disk that cannot be read is let
   * through: the attempt's own writes report it if it really is full.
   */
  public reserve(request: SpaceRequest): Promise<SpaceReservation> {
    const next = this.queue.then(() => this.check(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Whether `error` (an error, its code, or a process's output) says a disk is full. */
  public static isNoSpace(error: unknown): boolean {
    if (typeof error === "string") return NO_SPACE_TEXT.test(error);
    if (error instanceof DiskFullError || error instanceof OutOfSpaceError) return true;
    if (!(error instanceof Error)) return false;
    if ("code" in error && typeof error.code === "string" && NO_SPACE_CODES.has(error.code)) return true;
    return NO_SPACE_TEXT.test(error.message) || (error.cause !== undefined && DiskSpace.isNoSpace(error.cause));
  }

  /** Bytes as a short, human figure: `3.2 GB`. */
  public static format(bytes: number): string {
    return `${(Math.max(bytes, 0) / GIB).toFixed(1)} GB`;
  }

  // ---------- Checking ---------- //

  /** Checks both disks against what this attempt and every other running one still need. */
  private async check(request: SpaceRequest): Promise<SpaceReservation> {
    const scratch = await this.probe.volume(request.workspace);
    const library = request.library ? await this.probe.volume(request.library) : null;

    // A resumed transfer already holds part of its payload; the sterilized copy is always new
    const baseline = await this.probe.allocated(request.workspace);
    const scratchBytes = Math.max(0, 2 * request.bytes - baseline);
    const separateLibrary = library !== null && scratch !== null && library.device !== scratch.device;

    // Each disk must hold this attempt, what other attempts still have to write, and the margin
    if (scratch) {
      const shortfall = await this.shortfall(scratch, scratchBytes);
      if (shortfall) throw this.refusal("downloads folder", request.downloads, scratchBytes, shortfall.available);
    }
    if (separateLibrary && library) {
      const shortfall = await this.shortfall(library, request.bytes);
      if (shortfall) throw this.refusal("library", request.library, request.bytes, shortfall.available);
    }

    // Hold the room until the attempt ends
    const claim: Claim = {
      workspace: request.workspace,
      scratchDevice: scratch?.device ?? -1,
      scratchBytes,
      scratchBaseline: baseline,
      libraryDevice: separateLibrary && library ? library.device : null,
      libraryBytes: request.bytes,
    };
    this.claims.add(claim);
    return { release: () => this.claims.delete(claim) };
  }

  /** How much is available for new work on `volume`, when that is less than `needed`; null when it fits. */
  private async shortfall(volume: Volume, needed: number): Promise<{ available: number } | null> {
    const available = volume.freeBytes - (await this.outstanding(volume.device)) - this.headroom;
    return available < needed ? { available } : null;
  }

  /** Bytes other running attempts are yet to write to `device`. */
  private async outstanding(device: number): Promise<number> {
    let total = 0;
    for (const claim of this.claims) {
      if (claim.scratchDevice === device) {
        const written = Math.max(0, (await this.probe.allocated(claim.workspace)) - claim.scratchBaseline);
        total += Math.max(0, claim.scratchBytes - written);
      }
      if (claim.libraryDevice === device) total += claim.libraryBytes;
    }
    return total;
  }

  /** The error for a disk that cannot take the attempt. */
  private refusal(place: string, path: string, needed: number, available: number): OutOfSpaceError {
    return new OutOfSpaceError(
      `Not enough disk space: this release needs ${DiskSpace.format(needed + this.headroom)} free in the ${place} (${path}), ` +
        `and only ${DiskSpace.format(available + this.headroom)} is available. Free some space, then retry.`,
    );
  }
}
