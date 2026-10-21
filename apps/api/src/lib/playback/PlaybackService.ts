/**
 * Runs playback: starts and ends sessions, enforces the transcode limit,
 * reaps sessions whose player has gone away, and switches the whole feature
 * on and off with its setting. Turning playback off ends every session, kills
 * their ffmpeg runs, stops any TV Findr is driving and stops the indexer;
 * what was indexed and watched is kept for when it is turned back on.
 *
 * Sessions come in three kinds that share the limit and the reaper: HLS for
 * a browser, HLS for a Google Cast receiver (made when the receiver first
 * asks for its cast URL), and a single progressive stream for a DLNA
 * renderer.
 */

import { stat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  AudioTrack,
  CreateSession,
  DeviceProfile,
  NowPlayingRecord,
  PlaybackItemKey,
  PlaybackSessionRecord,
  PlaybackSettings,
  RendererPlay,
} from "@findr/types/playback";
import { MediaItem } from "../db/models/MediaItem";
import { PlaybackPrefs } from "../db/models/PlaybackPrefs";
import { PlaybackProgress } from "../db/models/PlaybackProgress";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { UserAccount } from "../db/models/UserAccount";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { CastAddress } from "./CastAddress";
import { CastTicket, type CastTicketData } from "./CastTicket";
import DlnaController from "./dlna/DlnaController";
import { Ffmpeg } from "./Ffmpeg";
import MediaIndexer from "./MediaIndexer";
import type { ProbeInfo } from "./MediaProbe";
import { PlaybackDecider, type PlaybackPlan, TranscodeRequiredError } from "./PlaybackDecider";
import { PlaybackSession } from "./PlaybackSession";
import { ProgressiveSession } from "./ProgressiveSession";
import { StreamToken } from "./StreamToken";
import { Trickplay } from "./Trickplay";

// ---------- Errors ---------- //

/** A request playback can't serve, with the API error code and status to answer with. */
export class PlaybackError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    message = code,
  ) {
    super(message);
    this.name = "PlaybackError";
  }
}

/** Who is asking for a session. */
export interface SessionClient {
  userId: string;
  /** Whether the request came from the local network, which the remote bitrate cap does not apply to. */
  local: boolean;
}

/** Any kind of session. */
export type AnySession = PlaybackSession | ProgressiveSession;

/** A DLNA renderer a progressive session is made for. */
export interface RendererTarget {
  name: string;
  profile: DeviceProfile;
  /** Whether it takes Matroska files as they are. */
  acceptsMatroska: boolean;
  /** The MIME type it lists for MPEG-TS. */
  transportStreamType: string;
  /** The MIME type it lists for Matroska. */
  matroskaType: string;
}

/**
 * What a Google Cast receiver is assumed to decode. The Default Media
 * Receiver on every Chromecast plays H.264 High up to level 4.1 and AAC, up to
 * 1080p (Google's Cast supported media list); newer ones do more, but a cast
 * must work on all of them.
 */
const CAST_PROFILE: DeviceProfile = { videoCodecs: ["h264"], audioCodecs: ["aac", "mp3"], maxHeight: 1080, hdr: false, maxH264Level: 41 };

/** A session with no request or progress report for this long is ended. */
const IDLE_MS = 60_000;

/** What `prepare` settles before a session of any kind is made. */
interface Prepared {
  item: MediaItem;
  plan: PlaybackPlan;
  audio: ProbeInfo["audio"][number];
  startMs: number;
  settings: PlaybackSettings;
}

/** The parts of a request every kind of session is made from. */
interface PrepareRequest extends PlaybackItemKey {
  audioTrack: number | null;
  maxBitrate: number | null;
  startMs: number | null;
}

// ---------- Service ---------- //

export default class PlaybackService extends SelfManagedSingleton {
  private readonly sessions = new Map<string, AnySession>();
  /** Cast sessions by the ticket that made them, so a receiver's requests share one. */
  private readonly castSessions = new Map<string, string>();
  private reaper: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Starts playback if it is enabled. */
  public async start(): Promise<void> {
    await this.applySettings();
  }

  /**
   * Brings the service in line with the settings: started when enabled,
   * stopped otherwise. While running, TVs are let go when casting is turned
   * off and thumbnails are brought up to date.
   */
  public async applySettings(): Promise<void> {
    const settings = SettingsStore.section("playback");
    if (settings.enabled && !this.running) await this.turnOn();
    else if (!settings.enabled && this.running) await this.turnOff();
    else if (this.running) {
      if (!settings.casting) await this.endCasts();
      MediaIndexer.getInstance().refreshThumbnails();
    }
  }

  /** Ends everything; used before the process restarts. */
  public async stop(): Promise<void> {
    if (this.running) await this.turnOff();
  }

  /** Whether playback is on. */
  public get enabled(): boolean {
    return SettingsStore.section("playback").enabled;
  }

  // ---------- Sessions ---------- //

  /** Starts a session for a movie or episode on the asking device. */
  public async create(request: CreateSession, client: SessionClient): Promise<PlaybackSessionRecord> {
    const prepared = await this.prepare(request, request.deviceProfile, client);
    const session = await this.openHls(prepared, client.userId, "browser");
    const { item, plan, audio, startMs, settings } = prepared;

    // Other devices on the network get absolute URLs: the same stream for AirPlay, a ticket for Cast
    const playlistUrl = `/api/playback/stream/${StreamToken.issue(session.id)}/index.m3u8`;
    const base = settings.casting ? CastAddress.baseUrl() : null;
    const ticket = CastTicket.issue({
      userId: client.userId,
      titleId: item.titleId,
      season: item.season,
      episode: item.episode,
      audioTrack: request.audioTrack,
      maxBitrate: request.maxBitrate,
    });

    return {
      id: session.id,
      playlistUrl,
      mode: plan.mode,
      reasons: plan.reasons,
      durationMs: item.durationMs,
      audioTracks: this.audioTracks(item.probe),
      audioTrack: item.probe.audio.findIndex((track) => track.index === audio.index),
      startMs,
      height: plan.height,
      bitrate: plan.bitrate,
      remoteUrl: base ? `${base}${playlistUrl}` : null,
      castUrl: base ? `${base}/api/playback/cast/${ticket}/index.m3u8` : null,
      trickplayUrl: Trickplay.url(item.id, settings),
    };
  }

  /**
   * The session a cast ticket stands for, made on the receiver's first
   * request. The receiver is told where to start by the sender, so packaging
   * waits for its first segment request rather than guessing.
   */
  public async castSession(ticket: string, data: CastTicketData): Promise<PlaybackSession> {
    const existing = this.castSessions.get(ticket);
    const session = existing ? this.sessions.get(existing) : undefined;
    if (session instanceof PlaybackSession) return session;
    if (!SettingsStore.section("playback").casting) throw new PlaybackError("casting_disabled", 404);

    const prepared = await this.prepare({ ...data, startMs: 0 }, CAST_PROFILE, { userId: data.userId, local: true });
    const created = await this.openHls(prepared, data.userId, "cast");
    this.castSessions.set(ticket, created.id);
    return created;
  }

  /** Starts a progressive session for a DLNA renderer, returning it with its stream path. */
  public async createProgressive(request: RendererPlay, renderer: RendererTarget, userId: string): Promise<{ session: ProgressiveSession; path: string }> {
    const prepared = await this.prepare({ ...request, maxBitrate: null }, renderer.profile, { userId, local: true });
    const { item, plan, audio, startMs, settings } = prepared;
    const direct = renderer.acceptsMatroska && plan.mode === "remux";
    this.checkTranscodeLimit(!direct && plan.video === "encode", settings);

    const session = new ProgressiveSession({
      id: crypto.randomUUID(),
      userId,
      item,
      plan,
      settings,
      direct,
      transportStreamType: renderer.transportStreamType,
      matroskaType: renderer.matroskaType,
      deviceName: renderer.name,
      audioLanguage: audio.language,
      startMs,
    });
    this.sessions.set(session.id, session);
    return { session, path: `/api/playback/stream/${StreamToken.issue(session.id)}/${session.fileName}` };
  }

  /** Every running session, for the admin's Now playing list. */
  public nowPlaying(): NowPlayingRecord[] {
    const sessions = [...this.sessions.values()];
    const users = UserAccount.names(sessions.map((session) => session.userId));
    const hardware = SettingsStore.section("playback").hardwareAcceleration !== "none";

    return sessions
      .map((session): NowPlayingRecord | null => {
        const title = Title.find(session.item.titleId);
        if (!title) return null;
        return {
          id: session.id,
          user: users.get(session.userId) ?? null,
          titleId: title.id,
          tmdbId: title.tmdbId,
          mediaType: title.mediaType,
          season: session.item.season,
          episode: session.item.episode,
          device: session.device,
          deviceName: session.deviceName,
          mode: session instanceof ProgressiveSession && session.direct ? "direct" : session.plan.mode,
          reasons: session.plan.reasons,
          hardware: hardware && session.transcoding,
          positionMs: session.positionMs,
          durationMs: session.item.durationMs,
          startedAt: session.createdAt,
        };
      })
      .filter((record): record is NowPlayingRecord => record !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** A running session. */
  public get(id: string): AnySession | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * Ends a session; only its owner may, unless `userId` is null. A DLNA
   * session's renderer is stopped too.
   */
  public async end(id: string, userId: string | null): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || (userId !== null && session.userId !== userId)) return false;
    this.sessions.delete(id);
    for (const [ticket, sessionId] of this.castSessions) if (sessionId === id) this.castSessions.delete(ticket);
    if (session instanceof ProgressiveSession) await DlnaController.getInstance().released(id);
    await session.close();
    return true;
  }

  /** Ends every session playing any file of a title, such as one being deleted. */
  public async endForTitle(titleId: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.item.titleId === titleId) await this.end(session.id, null);
    }
  }

  // ---------- Lifecycle ---------- //

  private async turnOn(): Promise<void> {
    this.running = true;

    // Clear segments a previous process left behind
    const root = this.scratchRootOrNull(SettingsStore.section("playback"));
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});

    this.reaper = setInterval(() => void this.reap(), IDLE_MS / 4);
    this.reaper.unref?.();
    MediaIndexer.getInstance().start();
    console.log("[Playback] Enabled");
  }

  private async turnOff(): Promise<void> {
    this.running = false;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    MediaIndexer.getInstance().stop();
    await DlnaController.getInstance().stopAll();
    for (const id of [...this.sessions.keys()]) await this.end(id, null);
    console.log("[Playback] Disabled");
  }

  /** Ends every session on another device, as when casting is turned off. */
  private async endCasts(): Promise<void> {
    await DlnaController.getInstance().stopAll();
    for (const session of [...this.sessions.values()]) {
      if (session.device !== "browser") await this.end(session.id, null);
    }
  }

  /** Ends sessions whose player has stopped asking for anything. */
  private async reap(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastSeen > IDLE_MS) await this.end(session.id, null);
    }
  }

  // ---------- Making sessions ---------- //

  /**
   * Everything a session of any kind needs settled first: the file, still on
   * disk; the audio track; how to send it to this device; and where to start.
   */
  private async prepare(request: PrepareRequest, profile: DeviceProfile, client: SessionClient): Promise<Prepared> {
    if (!this.running) throw new PlaybackError("playback_disabled", 404);
    if (!(await Ffmpeg.available())) throw new PlaybackError("ffmpeg_missing", 503);
    const settings = SettingsStore.section("playback");

    // The file must be indexed and still on disk
    const item = MediaItem.findForKey(request);
    if (!item) throw new PlaybackError("not_playable", 404);
    if (!(await stat(item.path).catch(() => null))?.isFile()) {
      MediaItem.remove(item.id);
      throw new PlaybackError("not_playable", 404);
    }

    // Audio: the asked-for track, else the user's language, else the file's default
    const prefs = PlaybackPrefs.get(client.userId);
    const remembered = PlaybackProgress.lastAudioLanguage(client.userId, item.titleId);
    const audio = this.chooseAudio(item.probe, request.audioTrack, remembered ?? prefs.audioLanguage);

    // Cap the bitrate by the device's choice and, off the local network, the server's
    const remoteCap = !client.local && settings.remoteMaxBitrateMbps > 0 ? Math.round(settings.remoteMaxBitrateMbps * 1_000_000) : null;
    const caps = [request.maxBitrate, remoteCap].filter((cap): cap is number => cap !== null);
    const maxBitrate = caps.length > 0 ? Math.min(...caps) : null;

    let plan: PlaybackPlan;
    try {
      plan = PlaybackDecider.decide({ probe: item.probe, audioStream: audio.index, profile, maxBitrate, settings });
    } catch (error) {
      if (error instanceof TranscodeRequiredError) throw new PlaybackError("transcode_required", 409, error.message);
      throw error;
    }

    // Resume where the user left off unless told where to start; a finished item keeps no position, so one is a rewatch part-way
    const resume = PlaybackProgress.find(client.userId, request)?.positionMs ?? 0;
    const startMs = Math.min(request.startMs ?? resume, Math.max(item.durationMs - 1000, 0));
    return { item, plan, audio, startMs, settings };
  }

  /** Opens an HLS session in its own scratch directory. */
  private async openHls(prepared: Prepared, userId: string, device: "browser" | "cast"): Promise<PlaybackSession> {
    const { item, plan, audio, startMs, settings } = prepared;
    this.checkTranscodeLimit(plan.video === "encode", settings);

    const id = crypto.randomUUID();
    const directory = join(this.scratchRoot(settings), id);
    await mkdir(directory, { recursive: true });

    const session = new PlaybackSession({
      id,
      userId,
      item,
      plan,
      settings,
      directory,
      startMs,
      audioLanguage: audio.language,
      device,
      warm: device === "browser",
    });
    this.sessions.set(id, session);
    session.warmUp();
    return session;
  }

  /** Refuses another video transcode once the limit is reached. */
  private checkTranscodeLimit(encodes: boolean, settings: PlaybackSettings): void {
    if (!encodes) return;
    const running = [...this.sessions.values()].filter((session) => session.transcoding).length;
    if (running >= settings.maxConcurrentTranscodes) throw new PlaybackError("transcode_limit", 503);
  }

  // ---------- Helpers ---------- //

  /** Where session directories go. */
  private scratchRoot(settings: PlaybackSettings): string {
    const root = this.scratchRootOrNull(settings);
    if (!root) throw new PlaybackError("transcodes_path_unset", 503);
    return root;
  }

  private scratchRootOrNull(settings: PlaybackSettings): string | null {
    if (settings.transcodesPath) return settings.transcodesPath;
    const downloads = SettingsStore.section("paths").downloads;
    return downloads && isAbsolute(downloads) ? join(downloads, ".transcodes") : null;
  }

  /** Picks the audio track to send. */
  private chooseAudio(probe: ProbeInfo, requested: number | null, language: string): ProbeInfo["audio"][number] {
    const tracks = probe.audio;
    const first = tracks[0];
    if (!first) throw new PlaybackError("not_playable", 404);

    if (requested !== null && tracks[requested]) return tracks[requested];
    const wanted = language.toLowerCase();
    const inLanguage = wanted ? tracks.filter((track) => track.language === wanted) : [];
    return inLanguage.find((track) => track.isDefault) ?? inLanguage[0] ?? tracks.find((track) => track.isDefault) ?? first;
  }

  /** The audio tracks as the player lists them. */
  private audioTracks(probe: ProbeInfo): AudioTrack[] {
    return probe.audio.map((track, index) => ({
      index,
      codec: track.codec,
      channels: track.channels,
      language: track.language,
      title: track.title,
      isDefault: track.isDefault,
    }));
  }
}
