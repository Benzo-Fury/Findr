/**
 * One DLNA renderer: a TV or other device that plays a URL it is given. It
 * wraps the renderer's AVTransport, RenderingControl and ConnectionManager
 * services, and turns the formats it lists (`GetProtocolInfo`) into a
 * `DeviceProfile` for the playback decider.
 *
 * Audio-only renderers, such as speakers, are left out. Renderers list
 * containers and DLNA profile names, not codecs, so the profile is cautious: H.264 and AAC or MP3 always, and HEVC, AC-3, E-AC-3
 * and 4K only when the list names them.
 */

import type { DeviceProfile, PlaybackAudioCodec, PlaybackVideoCodec, RendererRecord, RendererState } from "@findr/types/playback";
import { type DeviceDescription, Upnp, type UpnpService } from "./Upnp";

/** Service types, without their version. */
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:";
const CONNECTION_MANAGER = "urn:schemas-upnp-org:service:ConnectionManager:";

/**
 * How long loading and starting may take. TVs often fetch and probe the
 * stream before they answer, which for a converted stream includes ffmpeg
 * starting up.
 */
const START_TIMEOUT_MS = 20_000;

/** UPnP transport states, simplified. */
const TRANSPORT_STATES: Record<string, RendererState> = {
  PLAYING: "playing",
  PAUSED_PLAYBACK: "paused",
  PAUSED_RECORDING: "paused",
  STOPPED: "stopped",
  TRANSITIONING: "loading",
  NO_MEDIA_PRESENT: "idle",
};

/** Where the renderer is in what it plays. */
export interface PositionInfo {
  positionMs: number;
  durationMs: number;
}

export class DlnaRenderer {
  public readonly id: string;
  public readonly name: string;
  public readonly manufacturer: string | null;
  public readonly model: string | null;
  public readonly location: string;
  /** Last time it answered a search. */
  public lastSeen = Date.now();

  private readonly transport: UpnpService;
  private readonly rendering: UpnpService | null;
  private readonly connection: UpnpService | null;
  /** The `protocolInfo` entries it accepts. */
  private sinks: string[] = [];
  private matroskaRefused = false;

  private constructor(description: DeviceDescription, location: string, transport: UpnpService) {
    this.id = description.udn.replace(/^uuid:/i, "");
    this.name = description.name;
    this.manufacturer = description.manufacturer;
    this.model = description.model;
    this.location = location;
    this.transport = transport;
    this.rendering = description.services.find((service) => service.serviceType.startsWith(RENDERING_CONTROL)) ?? null;
    this.connection = description.services.find((service) => service.serviceType.startsWith(CONNECTION_MANAGER)) ?? null;
  }

  /** Reads a renderer from its description URL; null for anything that can't be driven. */
  public static async open(location: string): Promise<DlnaRenderer | null> {
    const description = await Upnp.describe(location);
    const transport = description?.services.find((service) => service.serviceType.startsWith(AV_TRANSPORT));
    if (!description || !transport) return null;

    const renderer = new DlnaRenderer(description, location, transport);
    await renderer.readFormats();
    // Speakers are renderers too; skip anything that lists formats but no video
    if (renderer.sinks.length > 0 && !renderer.sinks.some((sink) => /:video\//i.test(sink))) return null;
    return renderer;
  }

  /** As the web app lists it. */
  public toRecord(): RendererRecord {
    return { id: this.id, name: this.name, manufacturer: this.manufacturer, model: this.model, direct: this.acceptsMatroska };
  }

  // ---------- Formats ---------- //

  /** Whether it plays Matroska files as they are: it lists them, and hasn't failed to play one. */
  public get acceptsMatroska(): boolean {
    return !this.matroskaRefused && this.sinks.some((sink) => /:video\/(x-matroska|x-mkv|mkv):/i.test(sink));
  }

  /**
   * Stops sending it Matroska for as long as Findr runs. Some TVs list it
   * and fetch the file, then never play it.
   */
  public refuseMatroska(): void {
    this.matroskaRefused = true;
  }

  /** Whether it shows JPEG photos: it lists them, or won't say what it takes. */
  public get acceptsJpeg(): boolean {
    return this.sinks.length === 0 || this.sinks.some((sink) => /:image\/jpeg:/i.test(sink));
  }

  /** The MIME type it lists for Matroska, as TVs name it differently. */
  public get matroskaType(): string {
    for (const sink of this.sinks) {
      const type = /^http-get:[^:]*:(video\/(?:x-matroska|x-mkv|mkv)):/i.exec(sink)?.[1];
      if (type) return type;
    }
    return "video/x-matroska";
  }

  /** The MIME type it lists for MPEG-TS, preferring the DLNA one. */
  public get transportStreamType(): string {
    for (const type of ["video/vnd.dlna.mpeg-tts", "video/mp2t", "video/mpeg"]) {
      if (this.sinks.some((sink) => sink.toLowerCase().includes(`:${type}:`))) return type;
    }
    return "video/mpeg";
  }

  /** What it decodes, read cautiously from the formats it lists. */
  public get profile(): DeviceProfile {
    const listed = this.sinks.join(",").toLowerCase();
    const videoCodecs: PlaybackVideoCodec[] = ["h264"];
    if (/hevc|h265|h\.265/.test(listed)) videoCodecs.push("hevc");

    const audioCodecs: PlaybackAudioCodec[] = ["aac", "mp3"];
    if (/ac3|ac-3|dolby/.test(listed)) audioCodecs.push("ac3");
    if (/eac3|e-ac-3|ec-3|ec3/.test(listed)) audioCodecs.push("eac3");

    return { videoCodecs, audioCodecs, maxHeight: /uhd|2160|3840|_4k/.test(listed) ? 2160 : 1080, hdr: false };
  }

  /** Reads the formats it accepts; a renderer that won't say is treated as the most basic. */
  private async readFormats(): Promise<void> {
    if (!this.connection) return;
    try {
      const result = await Upnp.call(this.connection, "GetProtocolInfo", {});
      this.sinks = (result.Sink ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    } catch {
      this.sinks = [];
    }
  }

  // ---------- Transport ---------- //

  /** Loads a URL with DIDL-Lite metadata describing it. Some TVs fetch the URL before answering. */
  public async load(url: string, metadata: string): Promise<void> {
    await Upnp.call(this.transport, "SetAVTransportURI", { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: metadata }, START_TIMEOUT_MS);
  }

  /** Starts or resumes. Sony and others answer only once the stream has begun, so this may take a while. */
  public async play(): Promise<void> {
    await Upnp.call(this.transport, "Play", { InstanceID: 0, Speed: 1 }, START_TIMEOUT_MS);
  }

  public async pause(): Promise<void> {
    await Upnp.call(this.transport, "Pause", { InstanceID: 0 });
  }

  public async stop(): Promise<void> {
    await Upnp.call(this.transport, "Stop", { InstanceID: 0 });
  }

  /** Seeks within what is loaded. */
  public async seek(positionMs: number): Promise<void> {
    await Upnp.call(this.transport, "Seek", { InstanceID: 0, Unit: "REL_TIME", Target: DlnaRenderer.clock(positionMs) });
  }

  public async state(): Promise<RendererState> {
    return (await this.transportInfo()).state;
  }

  /** Its state, and whether it reports an error with what it was given. */
  public async transportInfo(): Promise<{ state: RendererState; failed: boolean }> {
    const result = await Upnp.call(this.transport, "GetTransportInfo", { InstanceID: 0 });
    return { state: TRANSPORT_STATES[result.CurrentTransportState ?? ""] ?? "idle", failed: result.CurrentTransportStatus === "ERROR_OCCURRED" };
  }

  public async position(): Promise<PositionInfo> {
    const result = await Upnp.call(this.transport, "GetPositionInfo", { InstanceID: 0 });
    return { positionMs: DlnaRenderer.parseClock(result.RelTime), durationMs: DlnaRenderer.parseClock(result.TrackDuration) };
  }

  // ---------- Volume ---------- //

  /** Volume from 0 to 100, or null when it has no volume control. */
  public async volume(): Promise<{ volume: number | null; muted: boolean }> {
    if (!this.rendering) return { volume: null, muted: false };
    const [volume, mute] = await Promise.all([
      Upnp.call(this.rendering, "GetVolume", { InstanceID: 0, Channel: "Master" }).catch(() => null),
      Upnp.call(this.rendering, "GetMute", { InstanceID: 0, Channel: "Master" }).catch(() => null),
    ]);
    const level = Number(volume?.CurrentVolume);
    return { volume: Number.isFinite(level) ? level : null, muted: mute?.CurrentMute === "1" || mute?.CurrentMute === "true" };
  }

  public async setVolume(volume: number): Promise<void> {
    if (this.rendering) await Upnp.call(this.rendering, "SetVolume", { InstanceID: 0, Channel: "Master", DesiredVolume: Math.round(volume) });
  }

  public async setMuted(muted: boolean): Promise<void> {
    if (this.rendering) await Upnp.call(this.rendering, "SetMute", { InstanceID: 0, Channel: "Master", DesiredMute: muted ? 1 : 0 });
  }

  // ---------- Times ---------- //

  /** `H:MM:SS`, as UPnP writes positions. */
  public static clock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  /** Milliseconds from `H:MM:SS(.fff)`; 0 for `NOT_IMPLEMENTED` or anything unreadable. */
  public static parseClock(value: string | undefined): number {
    const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?/.exec(value?.trim() ?? "");
    if (!match) return 0;
    const [, hours = "0", minutes = "0", seconds = "0", fraction = ""] = match;
    const ms = fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0;
    return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + ms;
  }
}
