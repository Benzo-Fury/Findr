/**
 * The multivariant playlist in front of a session's media playlist. Apple's
 * HLS guidance asks for one even with a single variant, carrying the bitrate
 * (required), and the codecs, resolution, frame rate and dynamic range
 * (recommended), so a player knows what it is getting before it fetches any
 * media: Safari and Apple TV pick their decoder from it, and hls.js sets up
 * its buffers with it.
 *
 * Codecs are named as RFC 6381 does, from the probe for a copied stream and
 * from the encoder's settings for an encoded one. A codec that can't be
 * named exactly leaves the attribute out rather than guessing, as it is
 * optional and a wrong one can stop a player.
 *
 * Pure: everything is passed in.
 */

import type { ProbeInfo } from "./MediaProbe";
import type { PlaybackPlan } from "./PlaybackDecider";

/** H.264 `profile_idc` and constraint flags, in hex, by ffprobe's profile name. */
const H264_PROFILES: Record<string, string> = {
  "Constrained Baseline": "42c0",
  Baseline: "4200",
  Main: "4d40",
  Extended: "5800",
  High: "6400",
  "High 10": "6e00",
  "High 4:2:2": "7a00",
  "High 4:4:4 Predictive": "f400",
};

/** HEVC general profile space, profile and compatibility flags, by ffprobe's profile name. */
const HEVC_PROFILES: Record<string, string> = {
  Main: "1.6",
  "Main 10": "2.4",
};

/** Audio codecs as they are written in fragmented MP4. */
const AUDIO_CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  mp3: "mp4a.40.34",
  ac3: "ac-3",
  eac3: "ec-3",
  opus: "Opus",
  flac: "fLaC",
};

/** Transfer characteristics and the `VIDEO-RANGE` each is. */
const VIDEO_RANGES: Record<string, string> = { smpte2084: "PQ", "arib-std-b67": "HLG" };

/** Peak over average bitrate: the allowance ffmpeg's own HLS muxer adds when it writes `BANDWIDTH`. */
const PEAK_ALLOWANCE = 1.1;

export class HlsVariant {
  /** The multivariant playlist, with one variant: the media playlist at `mediaUri`. */
  public static playlist(probe: ProbeInfo, plan: PlaybackPlan, mediaUri: string): string {
    const average = Math.max(Math.round(plan.bitrate), 1);
    const attributes = [`BANDWIDTH=${Math.round(average * PEAK_ALLOWANCE)}`, `AVERAGE-BANDWIDTH=${average}`];

    const codecs = this.codecs(probe, plan);
    if (codecs) attributes.push(`CODECS="${codecs}"`);
    const { width, height } = this.size(probe, plan);
    attributes.push(`RESOLUTION=${width}x${height}`);
    if (probe.video.frameRate) attributes.push(`FRAME-RATE=${probe.video.frameRate.toFixed(3)}`);
    attributes.push(`VIDEO-RANGE=${this.range(probe, plan)}`);

    return ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS", `#EXT-X-STREAM-INF:${attributes.join(",")}`, mediaUri, ""].join("\n");
  }

  /** The video and audio codecs the segments hold, or null when either can't be named exactly. */
  public static codecs(probe: ProbeInfo, plan: PlaybackPlan): string | null {
    const video = plan.video === "encode" ? this.encodedVideo(plan) : this.copiedVideo(probe);
    const track = probe.audio.find((audio) => audio.index === plan.audioStream);
    const audio = plan.audio === "encode" ? AUDIO_CODECS.aac : AUDIO_CODECS[track?.codec ?? ""];
    return video && audio ? `${video},${audio}` : null;
  }

  /** The picture size sent: the file's, or scaled to the plan's height keeping its shape. */
  private static size(probe: ProbeInfo, plan: PlaybackPlan): { width: number; height: number } {
    if (plan.video === "copy" || plan.scaleToHeight === null) return { width: probe.video.width, height: probe.video.height };
    const height = plan.scaleToHeight;
    const width = Math.round((probe.video.width * height) / probe.video.height / 2) * 2;
    return { width, height };
  }

  /** SDR unless HDR video is sent as it is. */
  private static range(probe: ProbeInfo, plan: PlaybackPlan): string {
    if (plan.toneMap || !probe.video.hdr) return "SDR";
    return VIDEO_RANGES[probe.video.transfer ?? ""] ?? "SDR";
  }

  /** Encoded video is H.264 High, at the level its height needs. */
  private static encodedVideo(plan: PlaybackPlan): string {
    const level = plan.height <= 720 ? 31 : plan.height <= 1080 ? 41 : 51;
    return `avc1.6400${this.hex(level)}`;
  }

  /** A copied H.264 or HEVC stream's codec, from its probed profile and level; others aren't named. */
  private static copiedVideo(probe: ProbeInfo): string | null {
    const { codec, profile, level } = probe.video;
    if (!profile || !level) return null;
    switch (codec) {
      case "h264": {
        const flags = H264_PROFILES[profile];
        return flags ? `avc1.${flags}${this.hex(level)}` : null;
      }
      case "hevc": {
        // ffprobe's HEVC level is already 30 times the level. Main tier and x265's constraint flags are assumed;
        // players judge decoding by profile, tier and level
        const space = HEVC_PROFILES[profile];
        return space ? `hvc1.${space}.L${level}.90` : null;
      }
      default:
        return null;
    }
  }

  private static hex(value: number): string {
    return value.toString(16).padStart(2, "0");
  }
}
