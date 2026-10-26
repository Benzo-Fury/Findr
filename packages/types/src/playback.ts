import { z } from "zod";
import { MediaTypeSchema } from "./media";

/**
 * Playback of finished library files in the browser. The server probes each
 * saved file once, then remuxes or transcodes it on demand into fragmented-MP4
 * HLS sized to what the playing device can decode.
 *
 * The whole feature can be switched off from its settings section; while off
 * every playback route answers `playback_disabled` and the web app hides it.
 */

// ---------- Settings ---------- //

/** Heights a transcode may be capped to. */
export const TranscodeResolutionSchema = z.enum(["480p", "720p", "1080p", "2160p"]);
export type TranscodeResolution = z.infer<typeof TranscodeResolutionSchema>;

/** x264 speed presets, fastest first. */
export const EncoderPresetSchema = z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]);
export type EncoderPreset = z.infer<typeof EncoderPresetSchema>;

/** Hardware video encoders a transcode may use instead of x264. */
export const HardwareAccelerationSchema = z.enum(["none", "videotoolbox", "nvenc", "qsv", "vaapi", "amf", "rkmpp"]);
export type HardwareAcceleration = z.infer<typeof HardwareAccelerationSchema>;

/** The `playback` settings section. */
export const PlaybackSettingsSchema = z.object({
  /** Master switch for watching library files in Findr. */
  enabled: z.boolean().default(true),
  /** Allow re-encoding video. Off means files play only when the device can take their video as it is. */
  transcoding: z.boolean().default(true),
  /** Scratch space for segments; empty means a `.transcodes` folder inside the downloads path. */
  transcodesPath: z
    .string()
    .trim()
    .refine((value) => value === "" || /^(\/|[A-Za-z]:[\\/])/.test(value), "Must be an absolute path")
    .default(""),
  /** Video transcodes allowed at once. Remuxes are cheap and not counted. */
  maxConcurrentTranscodes: z.number().int().min(1).max(16).default(2),
  /** Bitrate cap for clients outside the local network, in Mbps. 0 means no cap. */
  remoteMaxBitrateMbps: z.number().nonnegative().default(0),
  /** The largest picture a transcode produces. */
  maxTranscodeResolution: TranscodeResolutionSchema.default("1080p"),
  /** x264 preset for transcodes. */
  encoderPreset: EncoderPresetSchema.default("veryfast"),
  /** x264 constant rate factor for uncapped transcodes; lower is better and larger. */
  h264Crf: z.number().int().min(15).max(35).default(23),
  /** ffmpeg threads per transcode. 0 lets ffmpeg decide. */
  threads: z.number().int().min(0).max(64).default(0),
  /** Pause producing segments once far enough ahead of the player. */
  throttleTranscodes: z.boolean().default(true),
  /** How far ahead of the player segments are produced before pausing. */
  throttleAheadSeconds: z.number().int().min(30).max(1800).default(180),
  /** Target segment length. */
  segmentSeconds: z.number().int().min(2).max(10).default(6),
  /** Segments further behind the player than this are deleted. */
  segmentKeepSeconds: z.number().int().min(60).max(7200).default(600),
  /** Hardware encoder for transcodes; `none` encodes with x264 on the CPU. */
  hardwareAcceleration: HardwareAccelerationSchema.default("none"),
  /** The render node VA-API encodes on. */
  vaapiDevice: z.string().trim().min(1).default("/dev/dri/renderD128"),
  /** Convert HDR to SDR when transcoding for a screen without HDR. Needs ffmpeg's zscale filter. */
  toneMapping: z.boolean().default(true),
  /** Offer casting: Google Cast, AirPlay and DLNA renderers, which may fetch media from the local network. */
  casting: z.boolean().default(true),
  /** The address TVs reach Findr at; empty uses this machine's local network address. */
  castBaseUrl: z
    .string()
    .trim()
    .refine((value) => value === "" || /^https?:\/\/[^\s/]+(\/.*)?$/.test(value), "Must be an http:// or https:// URL")
    .default(""),
  /** Generate scrubbing thumbnails for every library file. */
  trickplay: z.boolean().default(true),
  /** Seconds between scrubbing thumbnails. */
  trickplayIntervalSeconds: z.number().int().min(2).max(60).default(10),
  /** Width of each scrubbing thumbnail in pixels. */
  trickplayWidth: z.number().int().min(160).max(640).default(320),
  /** Stopping before this share of the runtime keeps no resume point. */
  minResumePercent: z.number().min(0).max(50).default(5),
  /** Stopping after this share of the runtime marks the item played. */
  maxResumePercent: z.number().min(50).max(100).default(90),
  /** Items shorter than this never keep a resume point. */
  minResumeDurationSeconds: z.number().int().min(0).default(300),
});
export type PlaybackSettings = z.infer<typeof PlaybackSettingsSchema>;

// ---------- Devices ---------- //

/** Video codecs a device may decode, as Findr names them. */
export const PlaybackVideoCodecSchema = z.enum(["h264", "hevc", "av1", "vp9"]);
export type PlaybackVideoCodec = z.infer<typeof PlaybackVideoCodecSchema>;

/** Audio codecs a device may decode inside fragmented MP4. */
export const PlaybackAudioCodecSchema = z.enum(["aac", "mp3", "opus", "flac", "ac3", "eac3"]);
export type PlaybackAudioCodec = z.infer<typeof PlaybackAudioCodecSchema>;

/** What the playing device can decode, measured by the client. */
export const DeviceProfileSchema = z.object({
  videoCodecs: z.array(PlaybackVideoCodecSchema).max(8),
  audioCodecs: z.array(PlaybackAudioCodecSchema).max(8),
  /** Tallest picture worth sending. */
  maxHeight: z.number().int().min(144).max(4320),
  /** Whether the device shows HDR as HDR rather than washed out. */
  hdr: z.boolean(),
  /** Highest H.264 level it decodes, as ffprobe numbers it (41 for 4.1); absent for no limit. */
  maxH264Level: z.number().int().min(10).max(62).optional(),
});
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

// ---------- Sessions ---------- //

/**
 * How a session delivers the file. `remux` copies video and audio into HLS;
 * `audio` copies video and converts audio; `transcode` re-encodes both.
 */
export const PlaybackModeSchema = z.enum(["remux", "audio", "transcode"]);
export type PlaybackMode = z.infer<typeof PlaybackModeSchema>;

/** One episode, or a movie when season and episode are null. */
export const PlaybackItemKeySchema = z.object({
  titleId: z.string().min(1),
  season: z.number().int().nonnegative().nullable().default(null),
  episode: z.number().int().nonnegative().nullable().default(null),
});
export type PlaybackItemKey = z.infer<typeof PlaybackItemKeySchema>;

/** `POST /api/playback/sessions`. */
export const CreateSessionSchema = PlaybackItemKeySchema.extend({
  deviceProfile: DeviceProfileSchema,
  /** Chosen quality cap in bits per second; null means as good as the device takes. */
  maxBitrate: z.number().int().positive().nullable().default(null),
  /** Index into the item's audio tracks; null picks by preference. */
  audioTrack: z.number().int().nonnegative().nullable().default(null),
  /** Where to start; null resumes from the saved position. */
  startMs: z.number().int().nonnegative().nullable().default(null),
});
export type CreateSession = z.infer<typeof CreateSessionSchema>;

/** One audio track of a library file. */
export interface AudioTrack {
  index: number;
  codec: string;
  channels: number;
  /** ISO 639-2 code when the file names one. */
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

/** A started session, as the player needs it. */
export interface PlaybackSessionRecord {
  id: string;
  /** Relative URL of the HLS playlist; carries its own access token. */
  playlistUrl: string;
  mode: PlaybackMode;
  /** Why the server re-encoded anything, e.g. `audio_codec:dts` or `bitrate_cap`. */
  reasons: string[];
  durationMs: number;
  audioTracks: AudioTrack[];
  audioTrack: number;
  /** Where the player should start. */
  startMs: number;
  /** Height and bitrate actually sent. */
  height: number;
  bitrate: number;
  /**
   * The playlist at an address other devices on the network can reach, for
   * AirPlay; null when Findr can't tell what that address is or casting is off.
   */
  remoteUrl: string | null;
  /**
   * A playlist for a Google Cast receiver, which gets its own session sized
   * for a TV and started only when the receiver asks; null when casting is off.
   */
  castUrl: string | null;
  /** Scrubbing thumbnails as a WebVTT storyboard, once generated. */
  trickplayUrl: string | null;
}

/**
 * `POST /api/playback/cast`: a Google Cast URL for another audio track or
 * quality, so a receiver already casting can switch without the browser
 * starting a session of its own.
 */
export const CreateCastUrlSchema = PlaybackItemKeySchema.extend({
  /** Index into the item's audio tracks; null picks by preference. */
  audioTrack: z.number().int().nonnegative().nullable().default(null),
  /** Quality cap in bits per second; null means as good as the receiver takes. */
  maxBitrate: z.number().int().positive().nullable().default(null),
});
export type CreateCastUrl = z.infer<typeof CreateCastUrlSchema>;

/** A playlist URL for a Google Cast receiver. */
export interface CastUrlRecord {
  url: string;
}

// ---------- Progress ---------- //

/** Why the player reports its position. */
export const ProgressEventSchema = z.enum(["tick", "pause", "seek", "stop"]);
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

/** `POST /api/playback/progress`. A `stop` with a session id also ends that session. */
export const ReportProgressSchema = PlaybackItemKeySchema.extend({
  sessionId: z.string().min(1).nullable().default(null),
  positionMs: z.number().int().nonnegative(),
  event: ProgressEventSchema.default("tick"),
});
export type ReportProgress = z.infer<typeof ReportProgressSchema>;

/** `POST /api/playback/played`. */
export const MarkPlayedSchema = PlaybackItemKeySchema.extend({
  played: z.boolean(),
});
export type MarkPlayed = z.infer<typeof MarkPlayedSchema>;

/** A playable library item with the signed-in user's progress on it. */
export interface PlayableItem {
  titleId: string;
  tmdbId: number;
  mediaType: z.infer<typeof MediaTypeSchema>;
  season: number | null;
  episode: number | null;
  durationMs: number;
  /** Saved resume point; 0 when there is none. */
  positionMs: number;
  played: boolean;
  lastPlayedAt: number | null;
}

/** `GET /api/playback/library`: everything playable, plus what to suggest next. */
export interface PlaybackLibrary {
  items: PlayableItem[];
  /** Items with a resume point, most recently played first. */
  continueWatching: PlaybackItemKey[];
  /** For each show in progress, the next unplayed episode on disk. */
  nextUp: PlaybackItemKey[];
}

// ---------- Preferences ---------- //

/** Per-user playback preferences. */
export const PlaybackPrefsSchema = z.object({
  /** Preferred audio language, ISO 639-2 (e.g. `eng`); empty uses the file's default track. */
  audioLanguage: z.string().trim().max(8).default(""),
  /** Start the next episode when one ends. */
  autoplayNext: z.boolean().default(true),
  /** Ask whether anyone is watching after this many episodes in a row. 0 never asks. */
  stillWatchingAfter: z.number().int().min(0).max(20).default(3),
});
export type PlaybackPrefs = z.infer<typeof PlaybackPrefsSchema>;

// ---------- Capabilities ---------- //

/** `GET /api/playback/capabilities`: what the web app should offer. */
export interface PlaybackCapabilities {
  enabled: boolean;
  transcoding: boolean;
  /** Whether ffmpeg and ffprobe were found; without them nothing plays. */
  ffmpeg: boolean;
  /** Whether casting to TVs is offered. */
  casting: boolean;
  /** The address TVs will fetch media from, or null when it couldn't be worked out. */
  castBaseUrl: string | null;
}

// ---------- DLNA ---------- //

/** A DLNA renderer's transport state, simplified. */
export const RendererStateSchema = z.enum(["idle", "loading", "playing", "paused", "stopped", "unreachable"]);
export type RendererState = z.infer<typeof RendererStateSchema>;

/** A TV or other DLNA renderer found on the local network. */
export interface RendererRecord {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  /** Whether it accepts library files (Matroska) as they are; otherwise Findr sends MPEG-TS. */
  direct: boolean;
  /** The cast bridge it was found through, by name; null for the server's own network. */
  place: string | null;
}

/** `POST /api/playback/renderers/:id/play`. */
export const RendererPlaySchema = PlaybackItemKeySchema.extend({
  /** Where to start; null resumes from the saved position. */
  startMs: z.number().int().nonnegative().nullable().default(null),
  audioTrack: z.number().int().nonnegative().nullable().default(null),
  /** What the TV shows as the title, such as `Severance S01E02`. */
  label: z.string().trim().max(200).default(""),
});
export type RendererPlay = z.infer<typeof RendererPlaySchema>;

/** `POST /api/playback/renderers/:id/command`. */
export const RendererCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("play") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("seek"), positionMs: z.number().int().nonnegative() }),
  z.object({ action: z.literal("volume"), volume: z.number().int().min(0).max(100) }),
  z.object({ action: z.literal("mute"), muted: z.boolean() }),
]);
export type RendererCommand = z.infer<typeof RendererCommandSchema>;

/** `GET /api/playback/renderers/:id`: what a renderer Findr is driving is doing. */
export interface RendererStatus {
  renderer: RendererRecord;
  state: RendererState;
  /** The movie or episode Findr sent it, while it plays something of ours. */
  item: PlaybackItemKey | null;
  label: string | null;
  /** Whether the signed-in user started what it plays, and so may drive it. */
  mine: boolean;
  positionMs: number;
  durationMs: number;
  /** 0 to 100, or null when the renderer doesn't say. */
  volume: number | null;
  muted: boolean;
  mode: PlaybackMode | "direct" | null;
  /** The audio tracks of what it plays; empty while it plays nothing of ours. */
  audioTracks: AudioTrack[];
  /** Index into `audioTracks` of the one it plays, or null while it plays nothing of ours. */
  audioTrack: number | null;
}

// ---------- Cast bridges ---------- //

/**
 * A cast bridge: Findr run as `findr bridge` on another network, finding and
 * driving the DLNA TVs there for the server.
 */
export interface CastBridgeRecord {
  id: string;
  name: string;
  /** Whether it is connected now. */
  online: boolean;
  /** The Findr version it runs, while connected. */
  version: string | null;
  /** The address its TVs fetch media from, while connected. */
  address: string | null;
  /** TVs last found through it. */
  renderers: number;
  /** When it last connected or spoke, or null if it never has. */
  lastSeenAt: number | null;
  createdAt: number;
}

/** `POST /api/playback/bridges`. */
export const CreateCastBridgeSchema = z.object({
  /** Where it is, shown beside its TVs, such as `Home`. */
  name: z.string().trim().min(1).max(40),
});
export type CreateCastBridge = z.infer<typeof CreateCastBridgeSchema>;

/** A new bridge with its token, which is shown this once and never again. */
export interface CreatedCastBridge {
  bridge: CastBridgeRecord;
  token: string;
}

// ---------- Administration ---------- //

/** Where a session is being watched. */
export const PlaybackDeviceSchema = z.enum(["browser", "cast", "dlna"]);
export type PlaybackDevice = z.infer<typeof PlaybackDeviceSchema>;

/** One session in the admin's Now playing list. */
export interface NowPlayingRecord {
  id: string;
  user: { id: string; name: string; email: string } | null;
  titleId: string;
  tmdbId: number;
  mediaType: z.infer<typeof MediaTypeSchema>;
  season: number | null;
  episode: number | null;
  device: PlaybackDevice;
  /** The renderer's name, for DLNA. */
  deviceName: string | null;
  mode: PlaybackMode | "direct";
  reasons: string[];
  /** Whether video is encoded on a hardware encoder. */
  hardware: boolean;
  positionMs: number;
  durationMs: number;
  startedAt: number;
}

/** `POST /api/playback/admin/encoder-test`: whether the configured encoder works. */
export interface EncoderTestResult {
  ok: boolean;
  encoder: string;
  /** ffmpeg's complaint when it failed, or how long the test took. */
  message: string;
}
