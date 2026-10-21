/**
 * What this browser can decode, measured once and sent with every playback
 * request so the server copies whatever it can and converts only the rest.
 *
 * Codecs are checked through Media Source Extensions (what hls.js feeds),
 * falling back to the video element's own answer where MSE is missing, as on
 * iPhone, which plays HLS natively.
 */

import type { DeviceProfile, PlaybackAudioCodec, PlaybackVideoCodec } from "@findr/types/playback"

/** A representative codec string for each codec, as fragmented MP4 carries it. */
const VIDEO_PROBES: Record<PlaybackVideoCodec, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/mp4; codecs="vp09.00.40.08"',
}

const AUDIO_PROBES: Record<PlaybackAudioCodec, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mp4; codecs="mp4a.40.34"',
  opus: 'audio/mp4; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
}

/** Whether the browser says it can play a type, through MSE or the video element. */
function supports(type: string, video: HTMLVideoElement): boolean {
  const mse = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type)
  return mse || video.canPlayType(type) === "probably"
}

/** The tallest picture worth sending: the screen's physical height, rounded up to a standard tier. */
function maxHeight(): number {
  const physical = Math.max(window.screen.width, window.screen.height) * window.devicePixelRatio
  // Width decides the tier: a 1920-wide screen shows 1080p in full
  if (physical > 2600) return 2160
  if (physical > 1400) return 1080
  if (physical > 900) return 720
  return 480
}

let measured: DeviceProfile | null = null

/** This browser's profile, measured on first use. */
export function deviceProfile(): DeviceProfile {
  if (measured) return measured
  const video = document.createElement("video")

  measured = {
    videoCodecs: (Object.keys(VIDEO_PROBES) as PlaybackVideoCodec[]).filter((codec) => supports(VIDEO_PROBES[codec], video)),
    audioCodecs: (Object.keys(AUDIO_PROBES) as PlaybackAudioCodec[]).filter((codec) => supports(AUDIO_PROBES[codec], video)),
    maxHeight: maxHeight(),
    hdr: window.matchMedia("(dynamic-range: high)").matches,
  }

  // Every browser plays H.264 and AAC; keep them even if a probe answers oddly
  if (!measured.videoCodecs.includes("h264")) measured.videoCodecs.push("h264")
  if (!measured.audioCodecs.includes("aac")) measured.audioCodecs.push("aac")
  return measured
}
