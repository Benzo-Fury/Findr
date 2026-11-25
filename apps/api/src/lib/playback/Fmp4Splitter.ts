/**
 * Splits ffmpeg's fragmented-MP4 output into its init section and its
 * fragments as the bytes arrive, so a session can group fragments into HLS
 * segments itself instead of trusting ffmpeg's segmenter to cut where the
 * playlist says.
 *
 * ffmpeg keeps the file's own timestamps, which may not start at zero; every
 * fragment's decode time (`tfdt`) is shifted by a fixed offset onto the
 * timeline segments are measured on, so segments from separate runs line up
 * seamlessly for the player.
 */

// ---------- Types ---------- //

/** One `moof` + `mdat` pair, already shifted onto the file's timeline. */
export interface Fragment {
  /** When the fragment's video starts, in seconds; null for an audio-only fragment. */
  time: number | null;
  bytes: Uint8Array;
}

/** What the splitter reports as it goes. */
export interface SplitterEvents {
  /** The `ftyp` + `moov` bytes, once, before any fragment. */
  onInit(bytes: Uint8Array): void;
  onFragment(fragment: Fragment): void;
}

/** Thrown on output that isn't the fragmented MP4 the splitter expects. */
export class Fmp4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fmp4Error";
  }
}

/** A track as the `moov` describes it. */
interface Track {
  timescale: number;
  video: boolean;
}

/** Where one `traf`'s decode time sits inside a `moof`. */
interface DecodeTime {
  trackId: number;
  /** Byte offset of the time value within the `moof`. */
  at: number;
  wide: boolean;
}

/** A complete fragment before its decode times are shifted. */
interface PendingFragment {
  moof: Uint8Array;
  mdat: Uint8Array;
  times: DecodeTime[];
}

// ---------- Splitter ---------- //

export class Fmp4Splitter {
  /** Received bytes not yet consumed, in arrival order. */
  private parts: Uint8Array[] = [];
  private available = 0;
  private readonly initParts: Uint8Array[] = [];
  private initSent = false;
  private readonly tracks = new Map<number, Track>();
  /** The `moof` waiting for its `mdat`. */
  private moof: { bytes: Uint8Array; times: DecodeTime[] } | null = null;

  /** `offset` is the seconds added to every decode time. */
  constructor(
    private readonly events: SplitterEvents,
    private readonly offset: number,
  ) {}

  /** Feeds the next chunk of output. The chunk is copied, since a stream may reuse its buffer. */
  public push(chunk: Uint8Array): void {
    this.parts.push(chunk.slice());
    this.available += chunk.byteLength;

    // Consume every complete top-level box
    for (;;) {
      const header = this.peekHeader();
      if (!header || this.available < header.size) return;
      this.box(header.type, this.take(header.size), header.headerSize);
    }
  }

  // ---------- Boxes ---------- //

  /** Handles one complete top-level box. */
  private box(type: string, bytes: Uint8Array, headerSize: number): void {
    switch (type) {
      case "ftyp":
        this.initParts.push(bytes);
        return;
      case "moov":
        this.initParts.push(bytes);
        this.readTracks(bytes, headerSize);
        return;
      case "moof":
        this.sendInit();
        this.moof = { bytes, times: this.readDecodeTimes(bytes, headerSize) };
        return;
      case "mdat":
        if (!this.moof) throw new Fmp4Error("mdat without a moof");
        this.emit({ moof: this.moof.bytes, mdat: bytes, times: this.moof.times });
        this.moof = null;
        return;
      default:
        // `mfra`, `free` and the like carry nothing the player needs
        return;
    }
  }

  /** Reports the init section once, when the first fragment begins. */
  private sendInit(): void {
    if (this.initSent) return;
    if (this.tracks.size === 0) throw new Fmp4Error("fragment before moov");
    this.initSent = true;
    this.events.onInit(concat(this.initParts));
  }

  /** Rewrites a fragment's decode times and hands it on. */
  private emit(pending: PendingFragment): void {
    const offset = this.offset;
    let time: number | null = null;
    const view = new DataView(pending.moof.buffer, pending.moof.byteOffset, pending.moof.byteLength);

    for (const decode of pending.times) {
      const track = this.tracks.get(decode.trackId);
      if (!track) continue;

      // Shift by the offset in the track's own ticks; encoder priming that would
      // fall before the start of the file is pinned to it
      let shifted = this.read(view, decode) + BigInt(Math.round(offset * track.timescale));
      if (shifted < 0n) shifted = 0n;
      if (decode.wide) view.setBigUint64(decode.at, shifted);
      else if (shifted <= 0xffffffffn) view.setUint32(decode.at, Number(shifted));
      else throw new Fmp4Error("32-bit decode time overflowed");

      if (track.video) time = Number(shifted) / track.timescale;
    }
    this.events.onFragment({ time, bytes: concat([pending.moof, pending.mdat]) });
  }

  // ---------- Parsing ---------- //

  /** Records each track's id, timescale and kind from the `moov`. */
  private readTracks(moov: Uint8Array, headerSize: number): void {
    for (const trak of children(moov, headerSize, moov.byteLength)) {
      if (trak.type !== "trak") continue;
      let id = 0;
      let timescale = 0;
      let video = false;

      for (const box of children(moov, trak.body, trak.end)) {
        if (box.type === "tkhd") id = fullBoxVersion(moov, box) === 1 ? u32(moov, box.body + 20) : u32(moov, box.body + 12);
        if (box.type !== "mdia") continue;
        for (const inner of children(moov, box.body, box.end)) {
          if (inner.type === "mdhd") timescale = fullBoxVersion(moov, inner) === 1 ? u32(moov, inner.body + 20) : u32(moov, inner.body + 12);
          if (inner.type === "hdlr") video = fourcc(moov, inner.body + 8) === "vide";
        }
      }
      if (id > 0 && timescale > 0) this.tracks.set(id, { timescale, video });
    }
  }

  /** Finds every `traf`'s track id and where its `tfdt` value sits. */
  private readDecodeTimes(moof: Uint8Array, headerSize: number): DecodeTime[] {
    const times: DecodeTime[] = [];
    for (const traf of children(moof, headerSize, moof.byteLength)) {
      if (traf.type !== "traf") continue;
      let trackId = 0;
      let decode: { at: number; wide: boolean } | null = null;

      for (const box of children(moof, traf.body, traf.end)) {
        if (box.type === "tfhd") trackId = u32(moof, box.body + 4);
        if (box.type === "tfdt") decode = { at: box.body + 4, wide: fullBoxVersion(moof, box) === 1 };
      }
      if (trackId > 0 && decode) times.push({ trackId, ...decode });
    }
    return times;
  }

  /** A decode time in ticks. ffmpeg writes audio's priming before zero as a wrapped negative, so wide times are signed. */
  private read(view: DataView, decode: DecodeTime): bigint {
    return decode.wide ? view.getBigInt64(decode.at) : BigInt(view.getUint32(decode.at));
  }

  // ---------- Buffering ---------- //

  /** The next box's size and type, once enough bytes have arrived to tell. */
  private peekHeader(): { size: number; type: string; headerSize: number } | null {
    if (this.available < 8) return null;
    const head = this.peek(Math.min(16, this.available));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const size32 = view.getUint32(0);
    const type = fourcc(head, 4);

    if (size32 === 1) {
      if (head.byteLength < 16) return null;
      return { size: Number(view.getBigUint64(8)), type, headerSize: 16 };
    }
    if (size32 < 8) throw new Fmp4Error(`unsupported box size ${size32} for ${type}`);
    return { size: size32, type, headerSize: 8 };
  }

  /** The first `count` buffered bytes, without consuming them. */
  private peek(count: number): Uint8Array {
    const first = this.parts[0];
    if (first && first.byteLength >= count) return first.subarray(0, count);
    return concat(this.parts).subarray(0, count);
  }

  /** Removes and returns the first `count` buffered bytes. */
  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const part = this.parts[0];
      if (!part) throw new Fmp4Error("ran out of bytes");
      const used = Math.min(part.byteLength, count - filled);
      out.set(part.subarray(0, used), filled);
      filled += used;
      if (used === part.byteLength) this.parts.shift();
      else this.parts[0] = part.subarray(used);
    }
    this.available -= count;
    return out;
  }
}

// ---------- Box helpers ---------- //

/** A child box's type and extent within its parent's bytes. */
interface ChildBox {
  type: string;
  /** Offset of the first byte after the box header. */
  body: number;
  end: number;
}

/** The child boxes between `start` and `end`. */
function children(bytes: Uint8Array, start: number, end: number): ChildBox[] {
  const found: ChildBox[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = u32(bytes, at);
    let header = 8;
    if (size === 1) {
      size = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at + 8));
      header = 16;
    }
    if (size < header || at + size > end) break;
    found.push({ type: fourcc(bytes, at + 4), body: at + header, end: at + size });
    at += size;
  }
  return found;
}

/** A full box's version byte. */
function fullBoxVersion(bytes: Uint8Array, box: ChildBox): number {
  return bytes[box.body] ?? 0;
}

function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
