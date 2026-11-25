/**
 * The little of the Google Cast sender SDK the player drives itself. Video.js's
 * Cast extension loads the SDK and runs the cast session, but it loads only
 * the source it was given when casting began; switching a receiver that is
 * already casting to another stream (another audio track or quality) goes
 * through the SDK directly, so the browser starts no stream of its own.
 *
 * The SDK is a global script with no types in this project, so only the
 * members used here are declared.
 */

/** A media description the receiver loads. */
interface MediaInfo {
  contentType: string
  streamType: string
  hlsSegmentFormat: string
  hlsVideoSegmentFormat: string
  metadata: { images: unknown[] }
}

/** A request to load media on the receiver. */
interface LoadRequest {
  currentTime: number
  autoplay: boolean
}

/** The `chrome.cast` namespace, as far as it is used. */
interface ChromeCast {
  Image: new (url: string) => unknown
  media: {
    MediaInfo: new (contentId: string, contentType: string) => MediaInfo
    LoadRequest: new (mediaInfo: MediaInfo) => LoadRequest
    GenericMediaMetadata: new () => { images: unknown[] }
    StreamType: { BUFFERED: string }
    HlsSegmentFormat: { FMP4: string }
    HlsVideoSegmentFormat: { FMP4: string }
  }
}

/** A connected cast session. */
interface CastSession {
  loadMedia(request: LoadRequest): Promise<unknown>
}

/** The `cast` namespace, as far as it is used. */
interface CastFramework {
  framework: { CastContext: { getInstance(): { getCurrentSession(): CastSession | null } } }
}

/** HLS's MIME type, as Cast load requests name it. */
const HLS_TYPE = "application/vnd.apple.mpegurl"

/** The connected cast session, or null when nothing is casting or the SDK isn't loaded. */
function currentSession(): CastSession | null {
  const { cast } = globalThis as { cast?: CastFramework }
  try {
    return cast?.framework.CastContext.getInstance().getCurrentSession() ?? null
  } catch {
    return null
  }
}

/** Whether a Google Cast receiver is connected, as opposed to AirPlay or nothing. */
export function googleCastConnected(): boolean {
  return currentSession() !== null
}

/**
 * Loads one of Findr's HLS playlists on the connected receiver, from
 * `startSeconds`, described as the Cast extension describes it.
 */
export async function loadOnGoogleCast(url: string, options: { startSeconds: number; autoplay: boolean; poster: string | null }): Promise<void> {
  const session = currentSession()
  const { chrome } = globalThis as { chrome?: { cast?: ChromeCast } }
  const sdk = chrome?.cast
  if (!session || !sdk) throw new Error("Nothing is casting.")

  // Findr's playlists hold fragmented-MP4 segments
  const info = new sdk.media.MediaInfo(url, HLS_TYPE)
  info.streamType = sdk.media.StreamType.BUFFERED
  info.hlsSegmentFormat = sdk.media.HlsSegmentFormat.FMP4
  info.hlsVideoSegmentFormat = sdk.media.HlsVideoSegmentFormat.FMP4
  info.metadata = new sdk.media.GenericMediaMetadata()
  info.metadata.images = options.poster ? [new sdk.Image(options.poster)] : []

  const request = new sdk.media.LoadRequest(info)
  request.currentTime = options.startSeconds
  request.autoplay = options.autoplay
  await session.loadMedia(request)
}
