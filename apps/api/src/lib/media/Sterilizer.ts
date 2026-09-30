/**
 * Rewrites a downloaded video into a clean Matroska file holding only its
 * video and audio streams. Subtitles, attachments (fonts, images, anything
 * else smuggled into the container), chapters, tags, the container title and
 * per-track names are all dropped — none of it survives into the library.
 *
 * mkvmerge remuxes rather than re-encodes, so this takes seconds rather than
 * hours and is lossless. The output is always `.mkv`.
 */

import { env } from "../env/Env";
import { AttemptFailure, CancelledError, FatalDownloadError } from "../pipeline/errors";

// ---------- Types ---------- //

/** The subset of `mkvmerge -J` output the sterilizer reads. */
interface Identification {
  container?: { recognized?: boolean; supported?: boolean };
  tracks?: Array<{ id: number; type: "video" | "audio" | "subtitles" | string }>;
}

/** The result of running mkvmerge once. */
interface ProcessResult {
  exitCode: number;
  stdout: string;
}

/** mkvmerge exits 0 on success, 1 on success with warnings, 2 on error. */
const MKVMERGE_ERROR_EXIT = 2;

/** GUI mode prints progress as `#GUI#progress 42%`. */
const PROGRESS_LINE = /#GUI#progress (\d+)%/;
const ERROR_LINE = /#GUI#error (.+)/;

// ---------- Sterilizer ---------- //

export class Sterilizer {
  /**
   * Writes a sterilized copy of `input` to `output`. Fails the attempt when
   * the file is not a container mkvmerge supports or holds no video.
   */
  public async sterilize(
    input: string,
    output: string,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ): Promise<void> {
    // Inspect the streams before committing to a remux
    const tracks = await this.identify(input, signal);
    const kept = tracks.filter((track) => track.type === "video" || track.type === "audio");
    if (!kept.some((track) => track.type === "video")) {
      throw new AttemptFailure("Downloaded file contains no video stream");
    }

    // Keep audio and video, drop everything else, and blank every name
    const args = [
      "--gui-mode",
      "-o", output,
      "--title", "",
      "--no-subtitles",
      "--no-attachments",
      "--no-chapters",
      "--no-global-tags",
      "--no-track-tags",
      "--no-buttons",
      ...kept.flatMap((track) => ["--track-name", `${track.id}:`]),
      input,
    ];

    const result = await this.run(args, signal, (line) => {
      const progress = line.match(PROGRESS_LINE);
      if (progress?.[1]) onProgress(Number(progress[1]) / 100);
    });

    if (result.exitCode >= MKVMERGE_ERROR_EXIT) {
      const error = result.stdout.match(ERROR_LINE)?.[1] ?? `mkvmerge exited with code ${result.exitCode}`;
      throw new AttemptFailure(`Sterilize failed: ${error}`);
    }
  }

  /** Lists the file's tracks, failing when mkvmerge cannot read the container. */
  private async identify(input: string, signal: AbortSignal): Promise<Array<{ id: number; type: string }>> {
    const result = await this.run(["-J", input], signal);

    let identification: Identification;
    try {
      identification = JSON.parse(result.stdout) as Identification;
    } catch {
      throw new AttemptFailure("mkvmerge could not read the downloaded file");
    }

    if (!identification.container?.recognized || !identification.container.supported) {
      throw new AttemptFailure("Downloaded file is in a container format mkvmerge does not support");
    }
    return identification.tracks ?? [];
  }

  /**
   * Runs mkvmerge to completion, streaming stdout lines to `onLine`. Kills the
   * process on cancellation. A missing binary is fatal, since no candidate
   * could be sterilized without it.
   */
  private async run(args: string[], signal: AbortSignal, onLine?: (line: string) => void): Promise<ProcessResult> {
    let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
    try {
      child = Bun.spawn([env.MKVMERGE_PATH, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw new FatalDownloadError(`mkvmerge is not available at "${env.MKVMERGE_PATH}": ${error}`);
    }

    // Kill the process if the download is cancelled mid-remux
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });

    // Drain stderr alongside stdout so a chatty process never blocks on a full pipe
    const stderrDrained = new Response(child.stderr).text();

    // Collect stdout while handing each line to the caller
    let stdout = "";
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine?.(line);
    }

    const exitCode = await child.exited;
    await stderrDrained;
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) throw new CancelledError();

    return { exitCode, stdout };
  }
}
