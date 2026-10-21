/**
 * Decides how a library file reaches one device. Video is copied when the
 * device can decode it as it is and it fits the bitrate cap; otherwise it is
 * re-encoded to H.264, if transcoding is allowed. Audio is copied when the
 * device takes the codec and converted to stereo AAC otherwise, which is
 * cheap enough to allow always. Every reason for re-encoding is recorded so it
 * can be shown to the user.
 *
 * Pure: everything it needs is passed in, so it is tested as a table.
 */

import type { DeviceProfile, PlaybackAudioCodec, PlaybackMode, PlaybackSettings, PlaybackVideoCodec } from "@findr/types/playback";
import { AUDIO_BITRATE } from "./Ffmpeg";
import type { ProbeInfo } from "./MediaProbe";

// ---------- Types ---------- //

/** What the decider is given. */
export interface DecisionInput {
  probe: ProbeInfo;
  /** The audio stream to send, by its stream index in the file. */
  audioStream: number;
  profile: DeviceProfile;
  /** Highest total bitrate to send in bits per second, or null for no cap. */
  maxBitrate: number | null;
  settings: PlaybackSettings;
}

/** How one session sends its file. */
export interface PlaybackPlan {
  mode: PlaybackMode;
  reasons: string[];
  video: "copy" | "encode";
  audio: "copy" | "encode";
  videoStream: number;
  audioStream: number;
  sourceVideoCodec: string;
  /** Height to scale to when encoding, or null to keep the source's. */
  scaleToHeight: number | null;
  /** Video bitrate ceiling when encoding under a cap, or null for quality-based encoding. */
  videoBitrateCap: number | null;
  /** Map HDR down to SDR while encoding, for a screen that can't show HDR. */
  toneMap: boolean;
  /** Height and total bitrate the device receives. */
  height: number;
  bitrate: number;
}

/** Thrown when the device needs video re-encoded but transcoding is off. */
export class TranscodeRequiredError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Video must be transcoded (${reasons.join(", ")}) but transcoding is disabled`);
    this.name = "TranscodeRequiredError";
  }
}

/** ffprobe codec names Findr can send as they are, by the name devices report. */
const VIDEO_CODECS: Record<string, PlaybackVideoCodec> = { h264: "h264", hevc: "hevc", av1: "av1", vp9: "vp9" };
const AUDIO_CODECS: Record<string, PlaybackAudioCodec> = { aac: "aac", mp3: "mp3", opus: "opus", flac: "flac", ac3: "ac3", eac3: "eac3" };

/** Picture heights of each transcode cap. */
const RESOLUTION_HEIGHTS: Record<PlaybackSettings["maxTranscodeResolution"], number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "2160p": 2160,
};

/**
 * Rough bits per second an H.264 encode needs at each height, used to
 * estimate the size of an uncapped transcode.
 */
const TYPICAL_H264_BITRATE: Array<[height: number, bitrate: number]> = [
  [480, 2_000_000],
  [720, 4_500_000],
  [1080, 9_000_000],
  [2160, 30_000_000],
];

// ---------- Decider ---------- //

export class PlaybackDecider {
  /** Works out the plan, or throws `TranscodeRequiredError` when only a transcode would play and it is off. */
  public static decide(input: DecisionInput): PlaybackPlan {
    const { probe, profile, settings, maxBitrate } = input;
    const audio = probe.audio.find((track) => track.index === input.audioStream) ?? probe.audio[0];
    if (!audio) throw new Error("The file has no audio stream");

    // Audio: copy what the device decodes, else convert
    const audioCodec = AUDIO_CODECS[audio.codec];
    const copyAudio = audioCodec !== undefined && profile.audioCodecs.includes(audioCodec);
    const reasons: string[] = copyAudio ? [] : [`audio_codec:${audio.codec}`];

    // Video: every way the device or the cap can rule out a copy
    const videoReasons = this.videoReasons(probe, profile, maxBitrate);
    reasons.push(...videoReasons);

    if (videoReasons.length === 0) {
      return {
        mode: copyAudio ? "remux" : "audio",
        reasons,
        video: "copy",
        audio: copyAudio ? "copy" : "encode",
        videoStream: probe.video.index,
        audioStream: audio.index,
        sourceVideoCodec: probe.video.codec,
        scaleToHeight: null,
        videoBitrateCap: null,
        toneMap: false,
        height: probe.video.height,
        bitrate: probe.bitrate,
      };
    }
    if (!settings.transcoding) throw new TranscodeRequiredError(videoReasons);

    // Re-encode no taller than the source, the device or the server allows
    const height = Math.min(probe.video.height, profile.maxHeight, RESOLUTION_HEIGHTS[settings.maxTranscodeResolution]);
    const audioBitrate = copyAudio ? 0 : AUDIO_BITRATE;
    const videoBitrateCap = maxBitrate === null ? null : Math.max(maxBitrate - audioBitrate, 250_000);
    const estimate = this.typicalBitrate(height);

    return {
      mode: "transcode",
      reasons,
      video: "encode",
      audio: copyAudio ? "copy" : "encode",
      videoStream: probe.video.index,
      audioStream: audio.index,
      sourceVideoCodec: probe.video.codec,
      scaleToHeight: height < probe.video.height ? height - (height % 2) : null,
      videoBitrateCap,
      toneMap: settings.toneMapping && probe.video.hdr && !profile.hdr,
      height,
      bitrate: Math.min(videoBitrateCap ?? estimate, estimate) + audioBitrate,
    };
  }

  /** Why the video can't be copied to this device; empty when it can. */
  private static videoReasons(probe: ProbeInfo, profile: DeviceProfile, maxBitrate: number | null): string[] {
    const reasons: string[] = [];
    const codec = VIDEO_CODECS[probe.video.codec];

    if (!codec || !profile.videoCodecs.includes(codec)) reasons.push(`video_codec:${probe.video.codec}`);
    // Browsers decode only 8-bit H.264
    else if (codec === "h264" && probe.video.bitDepth > 8) reasons.push("bit_depth");
    // Older Chromecasts stop at level 4.1; a file probed without its level is assumed to fit
    else if (codec === "h264" && profile.maxH264Level !== undefined && (probe.video.level ?? 0) > profile.maxH264Level) reasons.push("h264_level");
    if (probe.video.height > profile.maxHeight) reasons.push("resolution");
    if (probe.video.hdr && !profile.hdr) reasons.push("hdr");
    if (maxBitrate !== null && probe.bitrate > maxBitrate) reasons.push("bitrate_cap");
    return reasons;
  }

  /** The usual H.264 bitrate for a picture height. */
  private static typicalBitrate(height: number): number {
    for (const [limit, bitrate] of TYPICAL_H264_BITRATE) if (height <= limit) return bitrate;
    return TYPICAL_H264_BITRATE.at(-1)?.[1] ?? 30_000_000;
  }
}
