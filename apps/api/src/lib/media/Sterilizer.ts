/**
 * Rewrites a downloaded video into a clean Matroska file holding only its
 * video and audio streams. Subtitles, attachments (fonts, images, anything
 * else smuggled into the container), cover art, chapters, tags, the container
 * title and per-track names are all dropped — none of it survives into the
 * library. Each audio track keeps only its language.
 *
 * The file is treated as hostile throughout (`MediaInput`): only Matroska and
 * MP4/MOV are accepted, identified from their first bytes before ffmpeg ever
 * opens them, and ffmpeg is held to that demuxer and to local files. Streams
 * are kept only in codecs on an allowlist of common ones, so a release can't
 * bring an obscure decoder into play later, when playback converts it.
 *
 * ffmpeg remuxes rather than re-encodes (`-c copy`), so this takes seconds
 * rather than hours and is lossless. The output is always `.mkv`.
 */

import { AttemptFailure, CancelledError, FatalDownloadError } from "../pipeline/errors";
import { FfmpegLocator } from "./FfmpegLocator";
import { MediaInput, type ContainerFormat } from "./MediaInput";

// ---------- Types ---------- //

/** The subset of `ffprobe -show_streams -show_format` output the sterilizer reads. */
interface Probe {
  streams?: Array<{
    index: number;
    codec_type?: string;
    codec_name?: string;
    disposition?: { attached_pic?: number };
    tags?: { language?: string };
  }>;
  format?: { duration?: string };
}

/** The result of running a binary once. */
interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A stream that goes into the library file. */
interface KeptStream {
  index: number;
  language: string | null;
}

/** Video codecs a library file may hold, by ffprobe's name. */
const VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp9"]);

/** Audio codecs a library file may hold, by ffprobe's name. */
const AUDIO_CODECS = new Set([
  "aac", "ac3", "eac3", "dts", "truehd", "flac", "opus", "mp3", "vorbis",
  "pcm_s16le", "pcm_s24le", "pcm_s32le",
]);

/** `-progress` reports how far the output has got like `out_time_us=1234567`. */
const PROGRESS_LINE = /^out_time_us=(\d+)$/;

// ---------- Sterilizer ---------- //

export class Sterilizer {
  /**
   * Writes a sterilized copy of `input` to `output`. Fails the attempt when
   * the file is not an accepted container, can't be read, or holds no video
   * (or only audio Findr doesn't take).
   */
  public async sterilize(
    input: string,
    output: string,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ): Promise<void> {
    // Identify the container from its bytes, never from its name
    const format = await MediaInput.sniff(input);
    if (!format) throw new AttemptFailure("Downloaded file is not a Matroska or MP4 video");

    // Inspect the streams before committing to a remux
    const { streams, durationSeconds } = await this.identify(input, format, signal);

    // Keep every stream of an allowed codec and drop the rest; blank every name, keep audio languages
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y", ...MediaInput.args(format, input)];
    for (const stream of streams) args.push("-map", `0:${stream.index}`);
    args.push("-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact");
    for (const [position, stream] of streams.entries()) {
      if (stream.language) args.push(`-metadata:s:${position}`, `language=${stream.language}`);
    }
    args.push("-progress", "pipe:1", "-f", "matroska", output);

    const result = await this.run(FfmpegLocator.path("ffmpeg"), args, signal, (line) => {
      // Without a duration there's no fraction to report, but a report still shows life
      const time = line.match(PROGRESS_LINE);
      if (time?.[1]) onProgress(durationSeconds ? Math.min(Number(time[1]) / 1e6 / durationSeconds, 0.99) : 0);
    });

    if (result.exitCode !== 0) {
      const error = result.stderr.trim().split("\n").at(-1) || `ffmpeg exited with code ${result.exitCode}`;
      throw new AttemptFailure(`Sterilize failed: ${error}`);
    }
    onProgress(1);
  }

  /**
   * Lists the streams to keep, failing when ffprobe can't read the container,
   * there is no video in an allowed codec, or there is audio but none in an
   * allowed codec.
   */
  private async identify(input: string, format: ContainerFormat, signal: AbortSignal): Promise<{ streams: KeptStream[]; durationSeconds: number | null }> {
    const result = await this.run(
      FfmpegLocator.path("ffprobe"),
      ["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_streams", "-show_format", ...MediaInput.args(format, input)],
      signal,
    );

    let probe: Probe;
    try {
      if (result.exitCode !== 0) throw new Error(result.stderr);
      probe = JSON.parse(result.stdout) as Probe;
    } catch {
      throw new AttemptFailure("ffprobe could not read the downloaded file");
    }

    // Cover art is a video stream too, flagged as an attached picture
    const all = probe.streams ?? [];
    const video = all.filter((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const audio = all.filter((stream) => stream.codec_type === "audio");
    const keptVideo = video.filter((stream) => VIDEO_CODECS.has(stream.codec_name ?? ""));
    const keptAudio = audio.filter((stream) => AUDIO_CODECS.has(stream.codec_name ?? ""));

    if (video.length === 0) throw new AttemptFailure("Downloaded file contains no video stream");
    if (keptVideo.length === 0) throw new AttemptFailure(`Downloaded file's video is in an unsupported codec (${video[0]?.codec_name ?? "unknown"})`);
    if (audio.length > 0 && keptAudio.length === 0) {
      throw new AttemptFailure(`Downloaded file's audio is in an unsupported codec (${audio[0]?.codec_name ?? "unknown"})`);
    }

    const language = (stream: (typeof all)[number]) => {
      const tag = stream.tags?.language?.trim().toLowerCase();
      return tag && tag !== "und" && /^[a-z]{2,3}(-[a-z0-9]+)?$/.test(tag) ? tag : null;
    };
    const duration = Number(probe.format?.duration);
    return {
      streams: [...keptVideo, ...keptAudio].map((stream) => ({ index: stream.index, language: language(stream) })),
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  }

  /**
   * Runs a binary to completion, streaming stdout lines to `onLine`. Kills
   * the process on cancellation. A missing binary is fatal, since no
   * candidate could be sterilized without it.
   */
  private async run(binary: string, args: string[], signal: AbortSignal, onLine?: (line: string) => void): Promise<ProcessResult> {
    let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
    try {
      child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw new FatalDownloadError(`${binary} is not available: ${error}`);
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
    const stderr = await stderrDrained;
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) throw new CancelledError();

    return { exitCode, stdout, stderr };
  }
}
