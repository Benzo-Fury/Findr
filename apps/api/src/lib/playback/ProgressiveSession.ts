/**
 * One library file playing on a DLNA renderer. Renderers want a single file
 * over HTTP rather than HLS, so this session serves either the library file
 * as it is, with byte ranges, when the renderer takes Matroska and every
 * stream in it; or an MPEG-TS that ffmpeg produces on the fly, from a start
 * time given in the URL. Only one ffmpeg run lives at a time: a new request
 * replaces the previous run.
 */

import type { PlaybackSettings } from "@findr/types/playback";
import type { MediaItem } from "../db/models/MediaItem";
import { env } from "../env/Env";
import { Ffmpeg } from "./Ffmpeg";
import type { PlaybackPlan } from "./PlaybackDecider";

// ---------- Types ---------- //

export interface ProgressiveOptions {
  id: string;
  userId: string;
  item: MediaItem;
  plan: PlaybackPlan;
  settings: PlaybackSettings;
  /** Serve the file as it is rather than through ffmpeg. */
  direct: boolean;
  /** The MIME type the renderer listed for MPEG-TS. */
  transportStreamType: string;
  /** The MIME type the renderer listed for Matroska. */
  matroskaType: string;
  deviceName: string;
  audioLanguage: string | null;
  startMs: number;
}

/** DLNA flags: streaming transfer, background transfer, DLNA 1.5. */
const DLNA_FLAGS = "01700000000000000000000000000000";

// ---------- Session ---------- //

export class ProgressiveSession {
  public readonly id: string;
  public readonly userId: string;
  public readonly item: MediaItem;
  public readonly plan: PlaybackPlan;
  public readonly direct: boolean;
  public readonly device = "dlna" as const;
  public readonly deviceName: string;
  public readonly audioLanguage: string | null;
  public readonly createdAt = Date.now();
  public lastSeen = Date.now();
  public positionMs: number;

  private readonly settings: PlaybackSettings;
  private readonly transportStreamType: string;
  private readonly matroskaType: string;
  private child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | null = null;
  private closed = false;
  /** Whether the renderer has asked for the media yet, logged once to show it can reach Findr. */
  private fetched = false;

  constructor(options: ProgressiveOptions) {
    this.id = options.id;
    this.userId = options.userId;
    this.item = options.item;
    this.plan = options.plan;
    this.settings = options.settings;
    this.direct = options.direct;
    this.transportStreamType = options.transportStreamType;
    this.matroskaType = options.matroskaType;
    this.deviceName = options.deviceName;
    this.audioLanguage = options.audioLanguage;
    this.positionMs = options.startMs;
  }

  /** Whether the session encodes video, which counts toward the transcode limit. */
  public get transcoding(): boolean {
    return !this.direct && this.plan.video === "encode";
  }

  /** The file name the renderer is given, whose extension some renderers go by. */
  public get fileName(): string {
    return this.direct ? "media.mkv" : "media.ts";
  }

  /** The type the renderer listed for the format, so the stream's `protocolInfo` matches one of its own. */
  public get contentType(): string {
    return this.direct ? this.matroskaType : this.transportStreamType;
  }

  /**
   * The DLNA features of the stream: the file supports byte seeking; the
   * transport stream supports none, and Findr seeks by loading it again from
   * a new start time instead.
   */
  public get dlnaFeatures(): string {
    return this.direct ? `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}` : `DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=${DLNA_FLAGS}`;
  }

  /** The `protocolInfo` the renderer is told the stream has. */
  public get protocolInfo(): string {
    return `http-get:*:${this.contentType}:${this.dlnaFeatures}`;
  }

  /** Marks the session as in use. */
  public touch(): void {
    this.lastSeen = Date.now();
  }

  /** Answers a renderer's request for the media; `startMs` positions a transport stream. */
  public serve(request: Request, startMs: number): Response {
    this.touch();
    if (!this.fetched) {
      this.fetched = true;
      console.info(`[Playback] ${this.deviceName} is fetching the ${this.direct ? "file as it is" : "MPEG-TS stream"}`);
    }
    const headers = new Headers({
      "Content-Type": this.contentType,
      "transferMode.dlna.org": this.transferMode(request),
      "contentFeatures.dlna.org": this.dlnaFeatures,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    return this.direct ? this.serveFile(request, headers) : this.serveTransportStream(request, headers, startMs);
  }

  /** The transfer mode the renderer asked for, as DLNA has servers echo it; streaming when it names none. */
  private transferMode(request: Request): string {
    const asked = request.headers.get("transferMode.dlna.org")?.trim();
    return asked === "Interactive" || asked === "Background" ? asked : "Streaming";
  }

  /** Stops the ffmpeg run, if any. */
  public async close(): Promise<void> {
    this.closed = true;
    this.child?.kill("SIGKILL");
    this.child = null;
  }

  // ---------- Delivery ---------- //

  /** The library file, whole or the one byte range asked for. */
  private serveFile(request: Request, headers: Headers): Response {
    const file = Bun.file(this.item.path);
    const size = file.size;
    headers.set("Accept-Ranges", "bytes");

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range")?.trim() ?? "");
    if (!range) {
      headers.set("Content-Length", String(size));
      return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
    }

    // `bytes=a-b`, `bytes=a-` or the last `bytes=-n`
    const [, from = "", to = ""] = range;
    let start = from === "" ? Math.max(size - Number(to), 0) : Number(from);
    let end = from === "" || to === "" ? size - 1 : Math.min(Number(to), size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    start = Math.max(start, 0);
    end = Math.max(end, start);

    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(request.method === "HEAD" ? null : file.slice(start, end + 1), { status: 206, headers });
  }

  /** A transport stream from `startMs`, produced while the renderer reads it. */
  private serveTransportStream(request: Request, headers: Headers, startMs: number): Response {
    if (request.method === "HEAD" || this.closed) return new Response(null, { status: this.closed ? 404 : 200, headers });

    // One run at a time: a new request replaces the last
    this.child?.kill("SIGKILL");
    const args = Ffmpeg.transportStreamArgs(this.item.path, this.plan, startMs / 1000, this.settings);
    let child: NonNullable<typeof this.child>;
    try {
      child = Bun.spawn([env.FFMPEG_PATH, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      return new Response(null, { status: 503, headers });
    }
    this.child = child;
    void new Response(child.stderr).text().then((stderr) => {
      if (stderr.trim() && this.child === child) console.warn(`[Playback] DLNA stream ${this.id}: ${stderr.trim().slice(-300)}`);
    });

    // The renderer hanging up ends the run; every chunk it reads keeps the session alive
    request.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    const body = child.stdout.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          this.touch();
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: 200, headers });
  }
}
