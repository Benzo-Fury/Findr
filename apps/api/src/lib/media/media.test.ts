import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NamingSettingsSchema } from "@findr/types/settings";
import { AttemptFailure } from "../pipeline/errors";
import { LibrarySaver } from "./LibrarySaver";
import { MediaInput } from "./MediaInput";
import { Sterilizer } from "./Sterilizer";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "findr-media-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A saver writing into this test's temp library. */
function saver(): LibrarySaver {
  return new LibrarySaver(
    { downloads: join(root, "dl"), movies: join(root, "movies"), series: join(root, "tv") },
    NamingSettingsSchema.parse({}),
  );
}

/** Creates a source file with some content and returns its path. */
async function source(name: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, "video bytes");
  return path;
}

// ---------- LibrarySaver ---------- //

describe("LibrarySaver", () => {
  test("names movies from the templates", async () => {
    const [saved] = await saver().save({
      mediaType: "movie",
      naming: { title: "Dune: Part Two", year: "2024" },
      season: null,
      items: [{ source: await source("a.mkv"), episodes: [] }],
    });
    expect(saved).toBe(join(root, "movies", "Dune Part Two (2024)", "Dune Part Two (2024).mkv"));
    expect(await Bun.file(saved ?? "").text()).toBe("video bytes");
  });

  test("names episodes, including multi-episode files", async () => {
    const saved = await saver().save({
      mediaType: "tv",
      naming: { title: "Severance", year: "2022" },
      season: 2,
      items: [
        { source: await source("a.mkv"), episodes: [1] },
        { source: await source("b.mkv"), episodes: [2, 3] },
      ],
    });
    expect(saved).toEqual([
      join(root, "tv", "Severance (2022)", "Season 02", "Severance - S02E01.mkv"),
      join(root, "tv", "Severance (2022)", "Season 02", "Severance - S02E02-E03.mkv"),
    ]);
  });

  test("drops the empty year parentheses when TMDB has no year", async () => {
    const [saved] = await saver().save({
      mediaType: "movie",
      naming: { title: "Untitled Project", year: "" },
      season: null,
      items: [{ source: await source("a.mkv"), episodes: [] }],
    });
    expect(saved).toBe(join(root, "movies", "Untitled Project", "Untitled Project.mkv"));
  });

  test("leaves no partial file behind when a move fails", async () => {
    const attempt = saver().save({
      mediaType: "movie",
      naming: { title: "Movie", year: "2024" },
      season: null,
      items: [{ source: join(root, "missing.mkv"), episodes: [] }],
    });
    await expect(attempt).rejects.toThrow();
    expect(await readdir(join(root, "movies", "Movie (2024)"))).toEqual([]);
  });

  test("fails clearly when the library is not configured", async () => {
    const unconfigured = new LibrarySaver({ downloads: "", movies: "", series: "" }, NamingSettingsSchema.parse({}));
    const attempt = unconfigured.save({
      mediaType: "movie",
      naming: { title: "Movie", year: "2024" },
      season: null,
      items: [{ source: await source("a.mkv"), episodes: [] }],
    });
    await expect(attempt).rejects.toThrow("movies library directory is not configured");
  });
});

// ---------- Sterilizer ---------- //

const hasTools = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

/** Container title and each stream's type, codec, name and language, via ffprobe. */
async function describeFile(path: string): Promise<{ title: string | undefined; streams: Array<[string, string, string | undefined, string | undefined]> }> {
  const output = (await Bun.$`ffprobe -v error -print_format json -show_format -show_streams ${path}`.json()) as {
    format: { tags?: { title?: string } };
    streams: Array<{ codec_type: string; codec_name: string; tags?: { title?: string; language?: string } }>;
  };
  return {
    title: output.format.tags?.title,
    streams: output.streams.map((stream) => [stream.codec_type, stream.codec_name, stream.tags?.title, stream.tags?.language]),
  };
}

/** Runs the sterilizer with no cancel, collecting its progress reports. */
async function sterilize(input: string, output = join(root, "out.mkv")): Promise<number[]> {
  const progress: number[] = [];
  await new Sterilizer().sterilize(input, output, new AbortController().signal, (value) => progress.push(value));
  return progress;
}

describe("MediaInput", () => {
  test("identifies Matroska and MP4 from their first bytes", () => {
    expect(MediaInput.identify(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("matroska");
    expect(MediaInput.identify(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe("mov");
    expect(MediaInput.identify(new TextEncoder().encode("RIFF\0\0\0\0AVI LIST"))).toBeNull();
    expect(MediaInput.identify(new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3"))).toBeNull();
    expect(MediaInput.identify(new Uint8Array())).toBeNull();
  });

  test("opens files as a fixed format, from a file: URL, with only the file protocol", () => {
    expect(MediaInput.args("matroska", "/lib/concat:a|b.mkv")).toEqual(["-f", "matroska", "-protocol_whitelist", "file", "-i", "file:/lib/concat:a|b.mkv"]);
  });
});

describe.skipIf(!hasTools)("Sterilizer", () => {
  test("keeps only audio and video, and strips titles and track names but not languages", async () => {
    const input = join(root, "in.mkv");
    await writeFile(join(root, "s.srt"), "1\n00:00:00,000 --> 00:00:01,000\nspam\n");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -f lavfi -i sine=d=1 -i ${join(root, "s.srt")} -map 0 -map 1 -map 2 -c:v libx264 -c:a aac -c:s srt -metadata title=SPAM -metadata:s:v:0 title=spammer -metadata:s:a:0 title=spam -metadata:s:a:0 language=jpn ${input}`;

    const progress = await sterilize(input);

    expect(await describeFile(join(root, "out.mkv"))).toEqual({
      title: undefined,
      streams: [["video", "h264", undefined, undefined], ["audio", "aac", undefined, "jpn"]],
    });
    expect(progress.at(-1)).toBe(1);
  });

  test("drops cover art and attachments", async () => {
    const input = join(root, "art.mkv");
    const cover = join(root, "cover.png");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=red:s=16x16 -frames:v 1 ${cover}`;
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -f lavfi -i sine=d=1 -c:v libx264 -c:a aac -attach ${cover} -metadata:s:t mimetype=image/png ${input}`;

    await sterilize(input);

    expect((await describeFile(join(root, "out.mkv"))).streams.map(([type]) => type)).toEqual(["video", "audio"]);
  });

  test("takes MP4 too, and writes Matroska", async () => {
    const input = join(root, "in.mp4");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -f lavfi -i sine=d=1 -c:v libx264 -c:a aac ${input}`;

    await sterilize(input);

    expect(MediaInput.identify(new Uint8Array(await Bun.file(join(root, "out.mkv")).slice(0, 4).arrayBuffer()))).toBe("matroska");
  });

  test("rejects a file that isn't Matroska or MP4, whatever its name", async () => {
    const fake = join(root, "fake.mkv");
    await writeFile(fake, "definitely not a video");
    await expect(sterilize(fake)).rejects.toThrow("not a Matroska or MP4 video");

    // A playlist named like a video, which ffmpeg would otherwise follow
    const playlist = join(root, "playlist.mkv");
    await writeFile(playlist, "#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n");
    await expect(sterilize(playlist)).rejects.toBeInstanceOf(AttemptFailure);
  });

  test("rejects AVI", async () => {
    const input = join(root, "old.avi");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -c:v mpeg4 ${input}`;
    await expect(sterilize(input)).rejects.toThrow("not a Matroska or MP4 video");
  });

  test("rejects video in a codec off the allowlist", async () => {
    const input = join(root, "mpeg4.mkv");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -c:v mpeg4 ${input}`;
    await expect(sterilize(input)).rejects.toThrow("unsupported codec (mpeg4)");
  });

  test("rejects a truncated file", async () => {
    const input = join(root, "whole.mkv");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -c:v libx264 ${input}`;
    const truncated = join(root, "cut.mkv");
    await writeFile(truncated, new Uint8Array(await Bun.file(input).slice(0, 64).arrayBuffer()));
    await expect(sterilize(truncated)).rejects.toBeInstanceOf(AttemptFailure);
  });

  test("rejects files with no video stream", async () => {
    const input = join(root, "audio.mka");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i sine=d=1 -c:a aac ${input}`;
    await expect(sterilize(input)).rejects.toThrow("no video stream");
  });
});
