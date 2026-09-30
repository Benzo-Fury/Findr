/**
 * One attempt at one candidate: fetch the torrent into the attempt's own
 * workspace, sterilize each selected file, and save the results to the
 * library. Records its phase and progress on the attempt as it goes.
 *
 * However the attempt ends — success, a bad release, cancellation, a crash in
 * a dependency — the torrent is removed from the client and the workspace is
 * deleted before this returns or throws. The library only ever receives
 * complete files, via the saver's atomic placement.
 */

import { join } from "node:path";
import type { MediaType } from "@findr/types/media";
import type { Settings } from "@findr/types/settings";
import type { Attempt } from "../db/models/Attempt";
import type { Candidate } from "../db/models/Candidate";
import { AttemptWorkspace } from "../downloader/AttemptWorkspace";
import type { Downloader } from "../downloader/Downloader";
import { FileInspector, type InspectionTarget } from "../downloader/FileInspector";
import { TorrentSession } from "../downloader/TorrentSession";
import { LibrarySaver, type TitleNaming } from "../media/LibrarySaver";
import { Sterilizer } from "../media/Sterilizer";
import Prowlarr from "../prowlarr/Prowlarr";
import { throwIfCancelled } from "./errors";

// ---------- Types ---------- //

export interface AttemptRequest {
  downloadId: string;
  mediaType: MediaType;
  season: number | null;
  candidate: Candidate;
  attempt: Attempt;
  inspection: InspectionTarget;
  naming: TitleNaming;
  settings: Settings;
  signal: AbortSignal;
}

/** What a successful attempt put in the library. */
export interface AttemptResult {
  files: string[];
  /** Episodes covered, for season packs and episode releases. */
  episodes: number[];
}

/** Progress changes smaller than this are not worth a database write. */
const PROGRESS_STEP = 0.01;

// ---------- Runner ---------- //

export class AttemptRunner {
  private readonly sterilizer = new Sterilizer();
  private readonly inspector = new FileInspector();

  constructor(private readonly downloader: Downloader) {}

  /** Runs the attempt to completion. Throws the pipeline's error types on failure. */
  public async run(request: AttemptRequest): Promise<AttemptResult> {
    const { attempt, settings, signal } = request;
    const workspace = new AttemptWorkspace(settings.paths.downloads, request.downloadId, request.candidate.id);
    const session = new TorrentSession(this.downloader, this.inspector, settings.watchdog);
    const reportProgress = this.throttledProgress(attempt);

    try {
      // Fresh workspace, and a torrent the client can add
      await workspace.prepare();
      const input = await Prowlarr.getInstance().resolveTorrent(request.candidate.source());
      throwIfCancelled(signal);

      // Download only the files inspection selected
      const fetched = await session.fetch({
        input,
        directory: workspace.payloadDir,
        tag: `findr-${attempt.id}`,
        target: request.inspection,
        signal,
        onDownloadStart: () => attempt.setPhase("downloading"),
        onProgress: reportProgress,
      });

      // Remux each file down to its audio and video
      attempt.setPhase("sterilizing");
      const sterilized: Array<{ source: string; episodes: number[] }> = [];
      for (const [index, file] of fetched.entries()) {
        const output = join(workspace.outputDir, `${index}.mkv`);
        await this.sterilizer.sterilize(file.absolutePath, output, signal, (progress) =>
          reportProgress((index + progress) / fetched.length),
        );
        sterilized.push({ source: output, episodes: file.episodes });
      }

      // The raw payload is no longer needed; free the disk before copying
      await session.discard();
      throwIfCancelled(signal);

      // Place the clean files in the library
      attempt.setPhase("saving");
      const saver = new LibrarySaver(settings.paths, settings.naming);
      const files = await saver.save({
        mediaType: request.mediaType,
        naming: request.naming,
        season: request.season,
        items: sterilized,
      });

      return { files, episodes: [...new Set(sterilized.flatMap((item) => item.episodes))].sort((a, b) => a - b) };
    } finally {
      // Always leave nothing behind, whatever happened above
      await session.discard();
      await workspace.dispose().catch((error: unknown) => {
        console.warn(`[Attempt] Could not remove workspace ${workspace.root}:`, error);
      });
    }
  }

  /** Writes progress to the attempt only when it has moved by a meaningful step. */
  private throttledProgress(attempt: Attempt): (progress: number) => void {
    let last = -1;
    return (progress) => {
      if (Math.abs(progress - last) < PROGRESS_STEP && progress < 1) return;
      last = progress;
      attempt.setProgress(progress);
    };
  }
}
