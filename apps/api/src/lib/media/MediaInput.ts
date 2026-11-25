/**
 * How ffmpeg and ffprobe are allowed to open a media file. Downloaded files
 * are hostile until proven otherwise, and ffmpeg will happily read any of
 * hundreds of formats — including playlists that point at other files or
 * URLs — if it is left to guess from the contents. So:
 *
 * - the container is identified here, from its first bytes, and only
 *   Matroska (and WebM) and MP4/MOV are accepted;
 * - ffmpeg is then told that format (`-f`), so it never probes for another
 *   demuxer;
 * - it may open local files only (`-protocol_whitelist file`), and the path
 *   is given as a `file:` URL, so no name can be read as another protocol;
 * - MP4's references to media in other files are never followed.
 */

import { open } from "node:fs/promises";

/** The containers Findr reads, by ffmpeg's demuxer name. */
export type ContainerFormat = "matroska" | "mov";

/** EBML's magic number, which opens every Matroska and WebM file. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** The `ftyp` box an MP4 or MOV file opens with, after its 4-byte size. */
const FTYP = [0x66, 0x74, 0x79, 0x70];

export class MediaInput {
  /** The container a file is in, read from its first bytes, or null when it is neither accepted kind. */
  public static async sniff(path: string): Promise<ContainerFormat | null> {
    const file = await open(path, "r");
    try {
      const head = new Uint8Array(12);
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      return this.identify(head.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  }

  /** The container some leading bytes belong to; separated from the filesystem for tests. */
  public static identify(head: Uint8Array): ContainerFormat | null {
    if (EBML_MAGIC.every((byte, index) => head[index] === byte)) return "matroska";
    if (FTYP.every((byte, index) => head[index + 4] === byte)) return "mov";
    return null;
  }

  /**
   * The input options that open `path` as `format` and nothing else. Options
   * meant for this input, such as a seek, go before these.
   */
  public static args(format: ContainerFormat, path: string): string[] {
    // MP4 can point at media in other files ("data references"); ffmpeg ignores them by default, and is told so
    const references = format === "mov" ? ["-enable_drefs", "0"] : [];
    return ["-f", format, ...references, "-protocol_whitelist", "file", "-i", `file:${path}`];
  }
}
