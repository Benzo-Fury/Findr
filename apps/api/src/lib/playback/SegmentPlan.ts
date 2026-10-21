/**
 * Where a session's HLS segments start and end, decided before any of them
 * exists, so the playlist can list the whole runtime up front and the player
 * can seek anywhere at once.
 *
 * Copied video can only be cut on its own keyframes, so a remux cuts at the
 * first keyframe at least one segment length after the previous cut. A
 * transcode places keyframes itself, every segment length exactly.
 */

/** Cuts closer than this to the end are merged into the last segment. */
const MIN_LAST_SEGMENT = 1;

export class SegmentPlan {
  /** Start time of each segment, in seconds; the first is always 0. */
  public readonly starts: readonly number[];

  private constructor(
    starts: number[],
    /** The runtime in seconds. */
    public readonly duration: number,
  ) {
    this.starts = starts;
  }

  /** Segments cut on the source's keyframes, for copied video. */
  public static fromKeyframes(keyframes: ArrayLike<number>, duration: number, target: number): SegmentPlan {
    const starts = [0];
    let last = 0;
    for (let i = 0; i < keyframes.length; i++) {
      const time = keyframes[i] ?? 0;
      if (time >= last + target && time <= duration - MIN_LAST_SEGMENT) {
        starts.push(time);
        last = time;
      }
    }
    return new SegmentPlan(starts, duration);
  }

  /** Segments of exactly `target` seconds, for encoded video. */
  public static fixed(duration: number, target: number): SegmentPlan {
    const starts: number[] = [];
    for (let time = 0; time === 0 || time <= duration - MIN_LAST_SEGMENT; time += target) starts.push(time);
    return new SegmentPlan(starts, duration);
  }

  /** How many segments there are. */
  public get count(): number {
    return this.starts.length;
  }

  /** Where segment `index` starts. */
  public start(index: number): number {
    return this.starts[index] ?? this.duration;
  }

  /** How long segment `index` lasts. */
  public length(index: number): number {
    return this.start(index + 1) - this.start(index);
  }

  /**
   * The segment a moment falls in. `tolerance` lets a fragment stamped a hair
   * before its cut, by decode-order rounding, still count as that segment.
   */
  public indexAt(seconds: number, tolerance = 0): number {
    // Binary search for the last start at or before the moment
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.starts[middle] ?? Infinity) <= seconds + tolerance) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /**
   * The VOD media playlist, with segments named `<index>.m4s` beside
   * `init.mp4`. A `startAt` past zero tells the player where to begin, so a
   * resumed session never fetches the opening segments first.
   */
  public playlist(startAt = 0): string {
    let longest = 0;
    for (let i = 0; i < this.count; i++) longest = Math.max(longest, this.length(i));

    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longest))}`,
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-INDEPENDENT-SEGMENTS",
    ];
    if (startAt > 0) lines.push(`#EXT-X-START:TIME-OFFSET=${startAt.toFixed(3)},PRECISE=YES`);
    lines.push('#EXT-X-MAP:URI="init.mp4"');
    for (let i = 0; i < this.count; i++) lines.push(`#EXTINF:${this.length(i).toFixed(6)},`, `${i}.m4s`);
    lines.push("#EXT-X-ENDLIST", "");
    return lines.join("\n");
  }
}
