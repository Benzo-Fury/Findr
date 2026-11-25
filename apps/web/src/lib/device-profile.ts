/**
 * What this browser can decode, measured once and sent with every playback
 * request so the server copies whatever it can and converts only the rest.
 *
 * Codecs are checked through Media Source Extensions (what hls.js feeds),
 * falling back to the video element's own answer where MSE is missing, as on
 * iPhone, which plays HLS natively. For each codec it decodes, Media
 * Capabilities is then asked how far the decoder goes: the tallest picture it
 * decodes smoothly, 10-bit, and HDR10. A browser that decodes 4K or HDR is
 * sent the file as it is even on a smaller or SDR screen, and scales or maps
 * it down itself, which costs the server nothing.
 *
 * Measurements can be optimistic. When a copied stream then fails to decode,
 * the player calls `recordDecodeFailure`, which narrows that codec here for
 * good, so the next file of the kind is converted from the start.
 */

import type { DeviceProfile, PlaybackAudioCodec, PlaybackVideoCodec, SourceVideo, VideoDecoder } from "@findr/types/playback"

/** A representative codec string for each codec, as fragmented MP4 carries it, at a 1080p level. */
const VIDEO_PROBES: Record<PlaybackVideoCodec, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/mp4; codecs="vp09.00.40.08"',
}

/** The same codecs at level 5.1, for asking about pictures taller than 1080p. */
const TALL_PROBES: Record<PlaybackVideoCodec, string> = {
  h264: 'video/mp4; codecs="avc1.640033"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L153.90"',
  av1: 'video/mp4; codecs="av01.0.13M.08"',
  vp9: 'video/mp4; codecs="vp09.00.51.08"',
}

/** The 10-bit profile of each codec that has one browsers decode (HEVC Main 10, AV1 Main 10-bit, VP9 profile 2). */
const TEN_BIT_PROBES: Partial<Record<PlaybackVideoCodec, string>> = {
  hevc: 'video/mp4; codecs="hvc1.2.4.L120.90"',
  av1: 'video/mp4; codecs="av01.0.08M.10"',
  vp9: 'video/mp4; codecs="vp09.02.40.10"',
}

const AUDIO_PROBES: Record<PlaybackAudioCodec, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mp4; codecs="mp4a.40.34"',
  opus: 'audio/mp4; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
}

/** Picture heights asked about, tallest first, with a bitrate typical of a release at each. */
const DECODE_TIERS: Array<{ height: number; bitrate: number }> = [
  { height: 2160, bitrate: 40_000_000 },
  { height: 1440, bitrate: 20_000_000 },
  { height: 1080, bitrate: 15_000_000 },
  { height: 720, bitrate: 6_000_000 },
]

/** Where codecs that failed to decode here are remembered, narrowed per codec. */
const FAILURES_KEY = "findr:decode-failures"

/** What a failed copy taught about one codec: each field, when present, narrows what was measured. */
interface Narrowing {
  unsupported?: true
  tenBit?: false
  hdr?: false
  maxHeight?: number
}

/** Whether the browser says it can play a type, through MSE or the video element. */
function supports(type: string, video: HTMLVideoElement): boolean {
  const mse = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type)
  return mse || video.canPlayType(type) === "probably"
}

/** The tallest picture worth sending: the screen's physical height, rounded up to a standard tier. */
function screenHeight(): number {
  const physical = Math.max(window.screen.width, window.screen.height) * window.devicePixelRatio
  // Width decides the tier: a 1920-wide screen shows 1080p in full
  if (physical > 2600) return 2160
  if (physical > 1400) return 1080
  if (physical > 900) return 720
  return 480
}

/** Whether Media Capabilities says a stream decodes, smoothly when asked; false when it can't say. */
async function decodes(contentType: string, height: number, bitrate: number, hdr: boolean, smooth: boolean): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.mediaCapabilities) return false
  const type = typeof MediaSource !== "undefined" ? "media-source" : "file"
  const video: VideoConfiguration = { contentType, width: Math.round((height * 16) / 9), height, bitrate, framerate: 24 }
  if (hdr) Object.assign(video, { hdrMetadataType: "smpteSt2086", colorGamut: "rec2020", transferFunction: "pq" })
  try {
    const info = await navigator.mediaCapabilities.decodingInfo({ type, video })
    return info.supported && (!smooth || info.smooth)
  } catch {
    // Older engines throw on fields they don't know, such as the HDR ones
    return false
  }
}

/**
 * Whether the browser can be trusted to map HDR to an SDR screen. Firefox
 * accepts HDR in Media Capabilities but shows it washed out, so it is sent
 * tone-mapped video instead.
 */
function mapsHdrItself(): boolean {
  return !/Firefox\//.test(navigator.userAgent)
}

/** How far this browser's decoder goes for one codec it plays. */
async function measureDecoder(codec: PlaybackVideoCodec, video: HTMLVideoElement, screen: number, hdrScreen: boolean): Promise<VideoDecoder> {
  // Browsers decode only 8-bit H.264
  const tenBitType = TEN_BIT_PROBES[codec]
  const tenBit = tenBitType !== undefined && supports(tenBitType, video)

  // The tallest tier that decodes smoothly; never less than the screen, which was always sent as it is
  let maxHeight = screen
  if (navigator.mediaCapabilities) {
    for (const tier of DECODE_TIERS) {
      if (tier.height <= screen) break
      const type = tier.height > 1080 ? TALL_PROBES[codec] : VIDEO_PROBES[codec]
      if (await decodes(type, tier.height, tier.bitrate, false, true)) {
        maxHeight = tier.height
        break
      }
    }
  }

  // HDR10 is 10-bit; an HDR screen shows it anyway, otherwise the browser must say it handles it
  const hdr = tenBit && tenBitType !== undefined && (hdrScreen || (mapsHdrItself() && (await decodes(tenBitType, 1080, 15_000_000, true, false))))
  return { codec, maxHeight, tenBit, hdr }
}

/** What earlier failures narrowed, by codec. */
function readNarrowings(): Partial<Record<PlaybackVideoCodec, Narrowing>> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FAILURES_KEY) ?? "{}")
    return stored && typeof stored === "object" ? (stored as Partial<Record<PlaybackVideoCodec, Narrowing>>) : {}
  } catch {
    return {}
  }
}

/** Applies what failures taught to a measured profile. */
function narrow(profile: DeviceProfile): DeviceProfile {
  const narrowings = readNarrowings()
  const videoCodecs = profile.videoCodecs.filter((codec) => codec === "h264" || !narrowings[codec]?.unsupported)
  const decoders = (profile.decoders ?? [])
    .filter((decoder) => videoCodecs.includes(decoder.codec))
    .map((decoder) => {
      const narrowing = narrowings[decoder.codec]
      if (!narrowing) return decoder
      return {
        ...decoder,
        tenBit: decoder.tenBit && narrowing.tenBit !== false,
        hdr: decoder.hdr && narrowing.hdr !== false,
        maxHeight: Math.min(decoder.maxHeight, narrowing.maxHeight ?? decoder.maxHeight),
      }
    })
  return { ...profile, videoCodecs, decoders }
}

/** Measures this browser from scratch. */
async function measure(): Promise<DeviceProfile> {
  const video = document.createElement("video")
  const videoCodecs = (Object.keys(VIDEO_PROBES) as PlaybackVideoCodec[]).filter((codec) => supports(VIDEO_PROBES[codec], video))
  const audioCodecs = (Object.keys(AUDIO_PROBES) as PlaybackAudioCodec[]).filter((codec) => supports(AUDIO_PROBES[codec], video))

  // Every browser plays H.264 and AAC; keep them even if a probe answers oddly
  if (!videoCodecs.includes("h264")) videoCodecs.unshift("h264")
  if (!audioCodecs.includes("aac")) audioCodecs.push("aac")

  const screen = screenHeight()
  const hdr = window.matchMedia("(dynamic-range: high)").matches
  const decoders = await Promise.all(videoCodecs.map((codec) => measureDecoder(codec, video, screen, hdr)))
  return { videoCodecs, audioCodecs, maxHeight: screen, hdr, decoders }
}

let measured: Promise<DeviceProfile> | null = null

/** This browser's profile, measured on first use, with what failed copies taught applied. */
export async function deviceProfile(): Promise<DeviceProfile> {
  measured ??= measure().catch(() => {
    // Without measurements the server judges by the screen alone, as it always could
    measured = null
    return { videoCodecs: ["h264"], audioCodecs: ["aac"], maxHeight: screenHeight(), hdr: false } satisfies DeviceProfile
  })
  return narrow(await measured)
}

/**
 * Remembers that a copy of `source` failed to decode here, narrowing the most
 * specific thing about it this browser was trusted with: HDR, then 10-bit,
 * then a picture taller than the screen, then the codec itself. H.264 is never
 * dropped, since everything else is converted to it.
 */
export async function recordDecodeFailure(source: SourceVideo): Promise<void> {
  const profile = await deviceProfile()
  const codec = profile.videoCodecs.find((name) => name === source.codec)
  if (!codec) return
  const decoder = profile.decoders?.find((entry) => entry.codec === codec)
  const narrowings = readNarrowings()
  const narrowing: Narrowing = { ...narrowings[codec] }

  if (source.hdr && decoder?.hdr && !profile.hdr) narrowing.hdr = false
  else if (source.bitDepth > 8 && decoder?.tenBit) narrowing.tenBit = false
  else if (decoder && source.height > profile.maxHeight && decoder.maxHeight >= source.height) narrowing.maxHeight = profile.maxHeight
  else if (codec !== "h264") narrowing.unsupported = true
  else return

  narrowings[codec] = narrowing
  try {
    localStorage.setItem(FAILURES_KEY, JSON.stringify(narrowings))
  } catch {
    // Remembering is a convenience; the failed session still retries converted
  }
}
