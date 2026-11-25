/**
 * One Google Cast device Findr drives, through Google's Default Media
 * Receiver: the app every Cast device runs, which plays a URL it is given and
 * reports how it is getting on. The receiver connects on first use and again
 * whenever its connection has dropped, launching the app (or joining it, when
 * it already runs) before loading anything.
 *
 * Everything goes through the network it was found on, so a device on a cast
 * bridge's network is driven exactly like one on the server's own.
 */

import type { DeviceProfile, RendererCapabilities, RendererOverrides, RendererRecord, RendererState } from "@findr/types/playback";
import type { RendererNetwork } from "../dlna/RendererNetwork";
import { PLATFORM_ID, SENDER_ID } from "./CastChannel";
import type { CastDevice, CastLink } from "./CastLink";
import type { CastFrame } from "./CastMessage";

// ---------- Protocol ---------- //

/** The namespaces driving a receiver takes. */
const CONNECTION_NS = "urn:x-cast:com.google.cast.tp.connection";
const RECEIVER_NS = "urn:x-cast:com.google.cast.receiver";
const MEDIA_NS = "urn:x-cast:com.google.cast.media";

/** Google's Default Media Receiver. */
const DEFAULT_RECEIVER = "CC1AD845";

/** How long a request may wait for its answer; launching an app is the slowest. */
const REQUEST_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 20_000;

/** An app running on the receiver, as its status lists it. */
interface RunningApp {
  appId: string;
  sessionId: string;
  transportId: string;
}

/** The receiver's own status: volume and what runs. */
interface ReceiverStatus {
  applications?: RunningApp[];
  volume?: { level?: number; muted?: boolean };
}

/** One media session's status, as the receiver reports it. */
interface MediaStatus {
  mediaSessionId: number;
  playerState: "IDLE" | "PLAYING" | "PAUSED" | "BUFFERING" | "LOADING";
  idleReason?: "CANCELLED" | "INTERRUPTED" | "FINISHED" | "ERROR";
  currentTime?: number;
}

/** A message from the receiver, as far as it is read. */
interface Reply {
  type: string;
  requestId?: number;
  status?: ReceiverStatus | MediaStatus[];
  reason?: string;
}

/** A request waiting for its answer. */
interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What the receiver is doing with what Findr loaded, simplified. */
export interface CastPlayback {
  state: RendererState;
  /** Whether it stopped on an error rather than by itself or the viewer. */
  failed: boolean;
  positionMs: number;
}

/** What to load: a URL, its type, and what the TV shows about it. */
export interface CastMedia {
  url: string;
  contentType: string;
  title: string;
  /** Where to start, for video. */
  startMs: number;
  /** A picture shown while it loads, as an absolute URL. */
  imageUrl: string | null;
}

/** A receiver's refusal or a failed request. */
export class CastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastError";
  }
}

// ---------- Receiver ---------- //

export class GoogleCastReceiver {
  /** Its Cast id, prefixed with the bridge's id when found through one, so the same device seen twice stays apart. */
  public readonly id: string;
  /** Last time it answered a search. */
  public lastSeen = Date.now();
  /** An admin's corrections to what it is taken to play, kept current by the controller. */
  public overrides: RendererOverrides = { hevc: null, uhd: null, hdr: null };

  private link: CastLink | null = null;
  private opening: Promise<CastLink> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  /** The app session Findr launched or joined, and its media session. */
  private app: RunningApp | null = null;
  private mediaSessionId: number | null = null;
  private receiverStatus: ReceiverStatus = {};
  private media: MediaStatus | null = null;

  constructor(
    /** What its search found; replaced when it answers again, as its address may change. */
    public device: CastDevice,
    /** The network it was found on, which every connection to it goes through. */
    public readonly network: RendererNetwork,
    /** What it is taken to decode before corrections, from the `chromecastProfile` setting. */
    private readonly detectedOf: () => RendererCapabilities,
  ) {
    this.id = network.local ? `cast-${device.id}` : `${network.id}:cast-${device.id}`;
  }

  /** As the web app lists it. */
  public toRecord(): RendererRecord {
    return {
      id: this.id,
      name: this.device.name,
      manufacturer: "Google",
      model: this.device.model,
      direct: false,
      place: this.network.place,
      capabilities: this.capabilities,
      detected: this.detected,
      overrides: this.overrides,
    };
  }

  // ---------- Formats ---------- //

  /** What it is taken to decode as it is, before an admin's corrections. */
  public get detected(): RendererCapabilities {
    return this.detectedOf();
  }

  /** What it is taken to decode, after an admin's corrections. */
  public get capabilities(): RendererCapabilities {
    const detected = this.detected;
    return { hevc: this.overrides.hevc ?? detected.hevc, uhd: this.overrides.uhd ?? detected.uhd, hdr: this.overrides.hdr ?? detected.hdr };
  }

  /** What it decodes, as the playback decider takes it. */
  public get profile(): DeviceProfile {
    return GoogleCastReceiver.profileOf(this.capabilities);
  }

  /** The device profile for a set of capabilities: H.264 always, HEVC, 4K and HDR as given. */
  public static profileOf(capabilities: RendererCapabilities): DeviceProfile {
    const maxHeight = capabilities.uhd ? 2160 : 1080;
    if (!capabilities.hevc) return { videoCodecs: ["h264"], audioCodecs: ["aac", "mp3"], maxHeight, hdr: false, maxH264Level: capabilities.uhd ? 51 : 41 };
    return {
      videoCodecs: ["h264", "hevc"],
      audioCodecs: ["aac", "mp3"],
      maxHeight,
      hdr: capabilities.hdr,
      maxH264Level: capabilities.uhd ? 51 : 41,
      decoders: [{ codec: "hevc", maxHeight, tenBit: true, hdr: capabilities.hdr }],
    };
  }

  // ---------- Playing ---------- //

  /** Launches (or joins) the media app and loads `media` on it, playing at once. */
  public async load(media: CastMedia): Promise<void> {
    const app = await this.launch();
    const video = media.contentType !== "image/jpeg";
    // The answer names the new media session
    this.mediaSessionId = null;
    this.media = null;
    const reply = await this.request(
      MEDIA_NS,
      app.transportId,
      {
        type: "LOAD",
        autoplay: true,
        currentTime: video ? media.startMs / 1000 : 0,
        media: {
          contentId: media.url,
          contentType: media.contentType,
          streamType: video ? "BUFFERED" : "NONE",
          // Findr's HLS is fragmented MP4, which the receiver must be told
          ...(video ? { hlsSegmentFormat: "fmp4", hlsVideoSegmentFormat: "fmp4" } : {}),
          metadata: { metadataType: 0, title: media.title, ...(media.imageUrl ? { images: [{ url: media.imageUrl }] } : {}) },
        },
      },
      LAUNCH_TIMEOUT_MS,
    );
    if (reply.type !== "MEDIA_STATUS") throw new CastError(`the receiver refused it (${reply.type}${reply.reason ? `: ${reply.reason}` : ""})`);
  }

  public async play(): Promise<void> {
    await this.mediaCommand({ type: "PLAY" });
  }

  public async pause(): Promise<void> {
    await this.mediaCommand({ type: "PAUSE" });
  }

  public async seek(positionMs: number): Promise<void> {
    await this.mediaCommand({ type: "SEEK", currentTime: positionMs / 1000, resumeState: "PLAYBACK_UNCHANGED" });
  }

  /** Closes the media app, returning the TV to its idle screen. Nothing to do when Findr's app isn't running. */
  public async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    this.mediaSessionId = null;
    this.media = null;
    if (!app || !this.link || this.link.closed) return;
    await this.request(RECEIVER_NS, PLATFORM_ID, { type: "STOP", sessionId: app.sessionId }).catch(() => {});
  }

  /** Sets the volume, 0 to 100. */
  public async setVolume(volume: number): Promise<void> {
    await this.request(RECEIVER_NS, PLATFORM_ID, { type: "SET_VOLUME", volume: { level: Math.min(Math.max(volume, 0), 100) / 100 } });
  }

  public async setMuted(muted: boolean): Promise<void> {
    await this.request(RECEIVER_NS, PLATFORM_ID, { type: "SET_VOLUME", volume: { muted } });
  }

  // ---------- Status ---------- //

  /**
   * Asks how what Findr loaded is getting on. A receiver whose app is no
   * longer Findr's, such as one another phone cast to, has stopped.
   */
  public async playback(): Promise<CastPlayback> {
    const app = this.app;
    if (!app) return { state: "stopped", failed: false, positionMs: 0 };

    // Our app must still be the one running
    await this.request(RECEIVER_NS, PLATFORM_ID, { type: "GET_STATUS" });
    if (!this.runningApps().some((running) => running.sessionId === app.sessionId)) {
      this.app = null;
      return { state: "stopped", failed: false, positionMs: this.positionMs };
    }

    await this.request(MEDIA_NS, app.transportId, { type: "GET_STATUS" });
    const media = this.media;
    if (!media) return { state: "loading", failed: false, positionMs: 0 };
    const positionMs = this.positionMs;
    switch (media.playerState) {
      case "PLAYING":
        return { state: "playing", failed: false, positionMs };
      case "PAUSED":
        return { state: "paused", failed: false, positionMs };
      case "BUFFERING":
      case "LOADING":
        return { state: "loading", failed: false, positionMs };
      case "IDLE":
        return { state: "stopped", failed: media.idleReason === "ERROR", positionMs };
    }
  }

  /** The volume, 0 to 100, as last reported; null before it has said. */
  public get volume(): { volume: number | null; muted: boolean } {
    const level = this.receiverStatus.volume?.level;
    return { volume: typeof level === "number" ? Math.round(level * 100) : null, muted: this.receiverStatus.volume?.muted ?? false };
  }

  /** Drops the connection, as when the receiver is forgotten. */
  public disconnect(): void {
    this.link?.close();
    this.link = null;
  }

  /** Where the media is, in milliseconds. */
  private get positionMs(): number {
    return Math.round((this.media?.currentTime ?? 0) * 1000);
  }

  // ---------- Inner workings ---------- //

  /** The apps the receiver last said run. */
  private runningApps(): RunningApp[] {
    return this.receiverStatus.applications ?? [];
  }

  /** Joins the media app when it already runs, else launches it, and opens a virtual connection to it. */
  private async launch(): Promise<RunningApp> {
    await this.request(RECEIVER_NS, PLATFORM_ID, { type: "GET_STATUS" });
    let app = this.runningApps().find((running) => running.appId === DEFAULT_RECEIVER);
    if (!app) {
      const reply = await this.request(RECEIVER_NS, PLATFORM_ID, { type: "LAUNCH", appId: DEFAULT_RECEIVER }, LAUNCH_TIMEOUT_MS);
      if (reply.type !== "RECEIVER_STATUS") throw new CastError(`the receiver wouldn't start its player (${reply.type}${reply.reason ? `: ${reply.reason}` : ""})`);
      app = this.runningApps().find((running) => running.appId === DEFAULT_RECEIVER);
      if (!app) throw new CastError("the receiver didn't start its player");
    }

    // A new app session means a new virtual connection
    if (this.app?.sessionId !== app.sessionId) {
      const link = await this.connection();
      link.send({ sourceId: SENDER_ID, destinationId: app.transportId, namespace: CONNECTION_NS, payload: JSON.stringify({ type: "CONNECT" }) });
      this.mediaSessionId = null;
      this.media = null;
    }
    this.app = app;
    return app;
  }

  /** Sends a command to the loaded media. */
  private async mediaCommand(command: Record<string, unknown>): Promise<void> {
    const app = this.app;
    if (!app || this.mediaSessionId === null) throw new CastError("nothing is loaded");
    const reply = await this.request(MEDIA_NS, app.transportId, { ...command, mediaSessionId: this.mediaSessionId });
    if (reply.type !== "MEDIA_STATUS") throw new CastError(`the receiver refused it (${reply.type})`);
  }

  /** Sends a request and waits for the answer carrying the same request id. */
  private async request(namespace: string, destinationId: string, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    const link = await this.connection();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CastError(`${this.device.name} didn't answer ${String(payload.type)}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      link.send({ sourceId: SENDER_ID, destinationId, namespace, payload: JSON.stringify({ ...payload, requestId }) });
    });
  }

  /** The open connection, opening one when there is none. */
  private connection(): Promise<CastLink> {
    if (this.link && !this.link.closed) return Promise.resolve(this.link);
    this.opening ??= (async () => {
      try {
        const link = await this.network.openCast(this.device);
        link.onMessage = (frame) => this.receive(frame);
        link.onClose = () => this.closed(link);
        // A new connection has no virtual connection to the app yet
        this.app = null;
        this.link = link;
        return link;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  /** Reads a message from the receiver: status kept, a waiting request answered. */
  private receive(frame: CastFrame): void {
    let reply: Reply;
    try {
      reply = JSON.parse(frame.payload) as Reply;
    } catch {
      return;
    }

    // Keep the latest status, whether asked for or broadcast
    if (reply.type === "RECEIVER_STATUS" && reply.status && !Array.isArray(reply.status)) this.receiverStatus = reply.status;
    if (reply.type === "MEDIA_STATUS" && Array.isArray(reply.status) && frame.sourceId === this.app?.transportId) {
      const media = reply.status.find((status) => this.mediaSessionId === null || status.mediaSessionId === this.mediaSessionId) ?? reply.status[0] ?? null;
      if (media) this.mediaSessionId = media.mediaSessionId;
      this.media = media;
    }

    // The answer to a request
    if (typeof reply.requestId !== "number" || reply.requestId === 0) return;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  /** Fails what waits on a connection that ended; the next request opens a new one. */
  private closed(link: CastLink): void {
    if (this.link !== link) return;
    this.link = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CastError(`lost the connection to ${this.device.name}`));
    }
    this.pending.clear();
  }
}
