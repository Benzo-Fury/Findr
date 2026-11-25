/**
 * One attempt at one candidate: fetch the torrent into the attempt's own
 * workspace, sterilize each selected file, and save the results to the
 * library. Records its phase and progress on the attempt as it goes.
 *
 * However the attempt ends — success, a bad release, cancellation, a crash in
 * a dependency — the torrent is removed from the client and the workspace is
 * deleted before this returns or throws, each given a minute so a hung
 * teardown cannot hold the download. The one exception is a pause by the VPN
 * killswitch: the workspace stays, so the candidate's next attempt resumes
 * the transfer instead of starting over. Removal waits until the files are saved,
 * since torrent teardown depends on the client and saving does not. The
 * library only ever receives complete files, via the saver's atomic placement.
 *
 * A `Heartbeat` watches for an attempt that has hung outright — no torrent
 * poll returning, no remux progress, no bytes copied — and fails it as a bad
 * release once it has been silent for the watchdog's stuck timeout. Slow
 * torrents keep beating; they are the torrent `Watchdog`'s call.
 */

import { join } from "node:path";
import type { AttemptPhase } from "@findr/types/downloads";
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
import { DiskSpace, type SpaceReservation } from "./DiskSpace";
import { OutOfSpaceError, SuspendedError, throwIfCancelled } from "./errors";
import { Heartbeat } from "./Heartbeat";

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
  /** Each saved file with the episodes it holds, in the same order as `files`. */
  saved: Array<{ path: string; episodes: number[] }>;
}

/** Progress changes smaller than this are not worth a database write. */
const PROGRESS_STEP = 0.01;

/** Longest a cleanup step may take before the attempt moves on without it. */
const CLEANUP_TIMEOUT_MS = 60_000;

const MINUTE = 60_000;

/** Each phase as the step a "disk filled up" message names. */
const PHASE_WORDS: Record<AttemptPhase, string> = {
  metadata: "preparing the release",
  downloading: "downloading",
  sterilizing: "sterilizing",
  saving: "saving",
  done: "finishing",
};

// ---------- Runner ---------- //

export class AttemptRunner {
  private readonly sterilizer = new Sterilizer();
  private readonly inspector = new FileInspector();

  /**
   * `space` is shared by every attempt this runner starts, so attempts running
   * side by side account for each other's reservations.
   */
  constructor(
    private readonly downloader: Downloader,
    private readonly space = new DiskSpace(),
  ) {}

  /** Runs the attempt to completion. Throws the pipeline's error types on failure. */
  public async run(request: AttemptRequest): Promise<AttemptResult> {
    const { settings } = request;
    const workspace = new AttemptWorkspace(settings.paths.downloads, request.downloadId, request.candidate.id);
    const session = new TorrentSession(this.downloader, this.inspector, settings.watchdog);
    const heartbeat = new Heartbeat(request.signal, { limitMs: settings.watchdog.stuckTimeoutMinutes * MINUTE });

    let paused = false;
    const reservation: { held: SpaceReservation | null } = { held: null };
    try {
      // Give up on the work the moment it is cancelled or stops showing signs of life
      return await heartbeat.guard(this.work(request, workspace, session, heartbeat, reservation));
    } catch (error) {
      paused = error instanceof SuspendedError;
      throw this.explainNoSpace(error, request);
    } finally {
      // Leave nothing behind, whatever happened above, except the files of a
      // transfer the killswitch paused. The client already let go of those, so
      // discarding its torrent cannot delete them. Each step is time-limited,
      // so a hung teardown cannot hold the download or a cancel
      heartbeat.dispose();
      await this.settle(`remove the torrent for attempt ${request.attempt.id}`, session.discard());
      if (!paused) await this.settle(`remove workspace ${workspace.root}`, workspace.dispose());
      reservation.held?.release();
    }
  }

  /** The attempt's steps, beating the heartbeat as each one shows progress. */
  private async work(
    request: AttemptRequest,
    workspace: AttemptWorkspace,
    session: TorrentSession,
    heartbeat: Heartbeat,
    reservation: { held: SpaceReservation | null },
  ): Promise<AttemptResult> {
    const { attempt, settings } = request;
    const { signal } = heartbeat;
    const reportProgress = this.throttledProgress(attempt);

    // Fresh workspace, and a torrent the client can add
    heartbeat.enter("preparing the release");
    await workspace.prepare();
    const input = await Prowlarr.getInstance().resolveTorrent(request.candidate.source());
    throwIfCancelled(signal);

    // Download only the files inspection selected
    heartbeat.enter("waiting on the torrent client");
    const fetched = await session.fetch({
      input,
      directory: workspace.payloadDir,
      tag: `findr-${attempt.id}`,
      target: request.inspection,
      signal,
      beforeDownload: async (files) => {
        // Refuse a release the disks cannot hold before a byte of it arrives
        const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
        reservation.held = await this.space.reserve({
          downloads: settings.paths.downloads,
          workspace: workspace.root,
          library: request.mediaType === "movie" ? settings.paths.movies : settings.paths.series,
          bytes,
        });
      },
      onDownloadStart: () => {
        heartbeat.enter("downloading");
        attempt.setPhase("downloading");
      },
      onProgress: reportProgress,
      onActivity: heartbeat.beat,
    });

    // Remux each file down to its audio and video
    throwIfCancelled(signal);
    heartbeat.enter("sterilizing");
    attempt.setPhase("sterilizing");
    const sterilized: Array<{ source: string; episodes: number[] }> = [];
    for (const [index, file] of fetched.entries()) {
      const output = join(workspace.outputDir, `${index}.mkv`);
      await this.sterilizer.sterilize(file.absolutePath, output, signal, (progress) => {
        heartbeat.beat();
        reportProgress((index + progress) / fetched.length);
      });
      sterilized.push({ source: output, episodes: file.episodes });
    }

    // Place the clean files in the library. The torrent is removed only
    // afterwards, in `run`, so a slow client teardown never holds up a
    // finished file
    throwIfCancelled(signal);
    heartbeat.enter("saving");
    attempt.setPhase("saving");
    const saver = new LibrarySaver(settings.paths, settings.naming);
    const files = await saver.save(
      { mediaType: request.mediaType, naming: request.naming, season: request.season, items: sterilized },
      {
        signal,
        onProgress: (progress) => {
          heartbeat.beat();
          reportProgress(progress);
        },
      },
    );

    return {
      files,
      episodes: [...new Set(sterilized.flatMap((item) => item.episodes))].sort((a, b) => a - b),
      saved: files.map((path, index) => ({ path, episodes: sterilized[index]?.episodes ?? [] })),
    };
  }

  /**
   * Turns a disk filling up during any step (the workspace, the torrent,
   * ffmpeg, the save) into `OutOfSpaceError`, so the download stops with a
   * message naming the step and the folder to clear instead of failing as a
   * bug or blaming the release. The technical cause goes to the log. Other
   * errors, and the space check's own refusal, pass through.
   */
  private explainNoSpace(error: unknown, request: AttemptRequest): unknown {
    if (error instanceof OutOfSpaceError || !DiskSpace.isNoSpace(error)) return error;
    const { downloads, movies, series } = request.settings.paths;
    const phase = request.attempt.phase;

    // Only the save writes to the library; everything before it writes to the downloads folder
    const [disk, folder] = phase === "saving" ? ["library", request.mediaType === "movie" ? movies : series] : ["downloads", downloads];
    return new OutOfSpaceError(`The ${disk} disk filled up while ${PHASE_WORDS[phase]}. Free some space in ${folder}, then retry.`, {
      cause: error,
    });
  }

  /** Waits for a cleanup step, but no longer than the cleanup limit. Never throws. */
  private async settle(label: string, work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), CLEANUP_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      work.then(
        () => "done" as const,
        (error: unknown) => {
          console.warn(`[Attempt] Could not ${label}:`, error);
          return "failed" as const;
        },
      ),
      limit,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") console.warn(`[Attempt] Gave up waiting to ${label} after ${CLEANUP_TIMEOUT_MS / 1000} s`);
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
