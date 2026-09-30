import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NamingSettingsSchema } from "@findr/types/settings";
import { AttemptFailure } from "../pipeline/errors";
import { LibrarySaver } from "./LibrarySaver";
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

const hasTools = Bun.which("mkvmerge") !== null && Bun.which("ffmpeg") !== null;

/** Tracks and container title of a Matroska file, via `mkvmerge -J`. */
async function describeFile(path: string): Promise<{ title: string | undefined; tracks: Array<[string, string | undefined]> }> {
  const output = await Bun.$`mkvmerge -J ${path}`.json();
  const identified = output as {
    container: { properties: { title?: string } };
    tracks: Array<{ type: string; properties: { track_name?: string } }>;
  };
  return {
    title: identified.container.properties.title,
    tracks: identified.tracks.map((track) => [track.type, track.properties.track_name]),
  };
}

describe.skipIf(!hasTools)("Sterilizer", () => {
  test("keeps only audio and video, and strips titles and track names", async () => {
    const input = join(root, "in.mkv");
    const output = join(root, "out.mkv");
    await writeFile(join(root, "s.srt"), "1\n00:00:00,000 --> 00:00:01,000\nspam\n");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=64x48:d=1 -f lavfi -i sine=d=1 -i ${join(root, "s.srt")} -map 0 -map 1 -map 2 -c:v libx264 -c:a aac -c:s srt -metadata title=SPAM -metadata:s:v:0 title=spammer ${input}`;

    const progress: number[] = [];
    await new Sterilizer().sterilize(input, output, new AbortController().signal, (value) => progress.push(value));

    expect(await describeFile(output)).toEqual({ title: undefined, tracks: [["video", undefined], ["audio", undefined]] });
    expect(progress.at(-1)).toBe(1);
  });

  test("rejects files mkvmerge cannot read", async () => {
    const input = join(root, "fake.mkv");
    await writeFile(input, "definitely not a video");
    const attempt = new Sterilizer().sterilize(input, join(root, "out.mkv"), new AbortController().signal, () => undefined);
    await expect(attempt).rejects.toBeInstanceOf(AttemptFailure);
  });

  test("rejects files with no video stream", async () => {
    const input = join(root, "audio.mka");
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i sine=d=1 -c:a aac ${input}`;
    const attempt = new Sterilizer().sterilize(input, join(root, "out.mkv"), new AbortController().signal, () => undefined);
    await expect(attempt).rejects.toThrow("no video stream");
  });
});
