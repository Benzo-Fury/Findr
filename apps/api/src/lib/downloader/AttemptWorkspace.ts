/**
 * The scratch directory for one attempt: `<downloads>/<downloadId>/<candidateId>/`.
 * Everything an attempt writes — the torrent payload and the sterilized
 * output — lives under it, so cleaning up after any outcome is one recursive
 * delete.
 *
 * An attempt the VPN killswitch paused skips that delete, and the same
 * candidate's next attempt finds its payload here and resumes it. The torrent
 * client verifies every piece by hash, so a payload is only ever a head
 * start, never trusted as is.
 */

import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FatalDownloadError } from "../pipeline/errors";

export class AttemptWorkspace {
  /** Root of this attempt's files. */
  public readonly root: string;
  /** Where the torrent client saves the payload. */
  public readonly payloadDir: string;
  /** Where sterilized files are written before being saved to the library. */
  public readonly outputDir: string;
  /** The download's directory, removed once its last attempt is gone. */
  private readonly downloadDir: string;

  /** Resolves the attempt's paths without touching the filesystem. */
  constructor(downloadsRoot: string, downloadId: string, candidateId: string) {
    if (!downloadsRoot || !isAbsolute(downloadsRoot)) {
      throw new FatalDownloadError("The downloads directory is not configured — set it in Settings");
    }

    this.downloadDir = resolve(downloadsRoot, downloadId);
    this.root = resolve(this.downloadDir, candidateId);
    this.payloadDir = join(this.root, "payload");
    this.outputDir = join(this.root, "output");

    // Guard the recursive delete against ids that could escape the root
    if (relative(downloadsRoot, this.root).startsWith("..") || this.root === resolve(downloadsRoot)) {
      throw new Error(`Attempt directory ${this.root} escapes ${downloadsRoot}`);
    }
  }

  /**
   * Readies the directories: an empty output directory, and the payload a
   * paused attempt left behind, if any, so its download carries on.
   */
  public async prepare(): Promise<void> {
    await rm(this.outputDir, { recursive: true, force: true });
    await mkdir(this.payloadDir, { recursive: true });
    await mkdir(this.outputDir, { recursive: true });
  }

  /** Deletes the attempt's files, and the download's directory if nothing else is in it. */
  public async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });

    // Tidy the parent only when empty; other attempts may still be using it
    const remaining = await readdir(this.downloadDir).catch(() => null);
    if (remaining && remaining.length === 0) await rmdir(this.downloadDir).catch(() => undefined);
  }
}
