/**
 * End-to-end tests of the download pipeline: TMDB and Prowlarr are mocked at
 * the HTTP layer, the torrent client is an in-memory fake that writes a real
 * Matroska fixture, and sterilizing runs the real mkvmerge.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { Attempt } from "../db/models/Attempt";
import { Candidate } from "../db/models/Candidate";
import { Download } from "../db/models/Download";
import { Episode } from "../db/models/Episode";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import type { AddOptions, Downloader, TorrentFile, TorrentInput, TorrentStatus } from "../downloader/Downloader";
import { AttemptRunner } from "./AttemptRunner";
import DownloadQueue from "./DownloadQueue";
import { DownloadRunner } from "./DownloadRunner";
import { ReleaseParser } from "../releases/ReleaseParser";
import { FatalDownloadError } from "./errors";

const hasTools = Bun.which("mkvmerge") !== null && Bun.which("ffmpeg") !== null;
const GB = 1024 ** 3;

// ---------- Fixtures ---------- //

let root: string;
let fixture: string;
const realFetch = globalThis.fetch;

/** What each fake torrent contains, keyed by the info hash in its magnet. */
const TORRENTS: Record<string, Array<[string, number]>> = {
  "matrix-malware": [["The.Matrix.1999.1080p.WEB-DL/The.Matrix.mkv", 4 * GB], ["The.Matrix.1999.1080p.WEB-DL/Codec.exe", 1000]],
  "matrix-good": [["The.Matrix.1999.1080p/The.Matrix.1999.1080p.mkv", 4 * GB], ["The.Matrix.1999.1080p/sample.mkv", 1000]],
  "matrix-old": [["The.Matrix.1999.720p.mkv", 2 * GB]],
  "matrix-cam": [["The.Matrix.1999.CAM.mkv", 2 * GB]],
  "show-pack": [["Show.S01/Show.S01E01.mkv", GB], ["Show.S01/Show.S01E02.mkv", GB]],
  "show-e01": [["Show.S01E01.1080p.mkv", GB]],
  "show-e02": [["Show.S01E02.1080p.mkv", GB]],
};

/** A Prowlarr release pointing at one of the fake torrents. */
function release(title: string, hash: string, sizeGB: number, seeders = 100) {
  return {
    title,
    size: sizeGB * GB,
    seeders,
    leechers: 1,
    indexer: "Fake",
    protocol: "torrent",
    magnetUrl: `magnet:?xt=urn:btih:${hash}`,
  };
}

/** Prowlarr search results by exact query string. */
const SEARCHES: Record<string, unknown[]> = {
  "{ImdbId:tt0133093}": [
    // The malicious release outranks the good one: better source, codec and seeding
    release("The.Matrix.1999.1080p.WEB-DL.x265-FLUX", "matrix-malware", 4, 900),
    release("The.Matrix.1999.1080p.WEBRip.x264-GRP", "matrix-good", 4, 400),
    release("The.Matrix.1999.CAM.x264", "matrix-cam", 2, 999),
  ],
  "{TvdbId:555} {Season:1}": [release("Show.S01.1080p.WEB-DL.x265-GRP", "show-pack", 2)],
  "{TvdbId:555} {Season:1} {Episode:1}": [release("Show.S01E01.1080p.WEB-DL.x265-GRP", "show-e01", 1)],
  "{TvdbId:555} {Season:1} {Episode:2}": [release("Show.S01E02.1080p.WEB-DL.x265-GRP", "show-e02", 1)],
};

/** TMDB responses by path. Episode 3 has aired but no release exists; episode 4 is unaired. */
const TMDB_PATHS: Record<string, unknown> = {
  "/3/movie/603": { title: "The Matrix", release_date: "1999-03-31", overview: "A hacker.", external_ids: { imdb_id: "tt0133093" } },
  "/3/tv/100": { name: "Show", first_air_date: "2020-01-01", overview: "A show.", external_ids: { imdb_id: "tt100", tvdb_id: 555 } },
  "/3/tv/100/season/1": {
    episodes: [
      { episode_number: 1, air_date: "2020-01-01" },
      { episode_number: 2, air_date: "2020-01-08" },
      { episode_number: 3, air_date: "2020-01-15" },
      { episode_number: 4, air_date: "2999-01-01" },
    ],
  },
};

/** Serves TMDB and Prowlarr from the tables above. */
function mockNetwork(): void {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.themoviedb.org") {
        const body = TMDB_PATHS[url.pathname];
        return body ? Response.json(body) : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/api/v1/search") return Response.json(SEARCHES[url.searchParams.get("query") ?? ""] ?? []);
      return new Response("unexpected", { status: 500 });
    },
    { preconnect: realFetch.preconnect },
  );
}

// ---------- Fake downloader ---------- //

/**
 * Serves the file lists in `TORRENTS` and "downloads" by copying the fixture
 * into place for each selected video. `hang` keeps transfers going forever;
 * `unavailable` makes every add fail as if the client were down.
 */
class FakeDownloader implements Downloader {
  public hang = false;
  public unavailable = false;
  public readonly live = new Map<string, { hash: string; directory: string; tag: string; started: boolean }>();
  private next = 0;

  public async add(input: TorrentInput, options: AddOptions): Promise<string> {
    if (this.unavailable) throw new FatalDownloadError("The torrent client is unavailable");
    const hash = input.kind === "magnet" ? (input.uri.split("btih:")[1] ?? "") : "file";
    const handle = `h${this.next++}`;
    this.live.set(handle, { hash, directory: options.directory, tag: options.tag, started: false });
    return handle;
  }

  public async files(handle: string): Promise<TorrentFile[] | null> {
    const torrent = this.live.get(handle);
    return (TORRENTS[torrent?.hash ?? ""] ?? []).map(([path, sizeBytes], index) => ({ index, path, sizeBytes }));
  }

  public async start(handle: string, indexes: number[]): Promise<void> {
    const torrent = this.live.get(handle);
    const files = (await this.files(handle)) ?? [];
    if (!torrent) return;
    torrent.started = true;
    if (this.hang) return;

    // Materialise each selected file as a real, playable Matroska file
    for (const file of files.filter((entry) => indexes.includes(entry.index))) {
      const target = join(torrent.directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(fixture, target);
    }
  }

  public async status(handle: string): Promise<TorrentStatus | null> {
    if (!this.live.has(handle)) return null;
    return this.hang
      ? { state: "downloading", downloadedBytes: Date.now(), totalBytes: GB, progress: 0.5, speedBytesPerSecond: 1, peers: 1 }
      : { state: "complete", downloadedBytes: GB, totalBytes: GB, progress: 1, speedBytesPerSecond: 0, peers: 1 };
  }

  public async stop(): Promise<void> {}

  public async remove(handle: string): Promise<void> {
    this.live.delete(handle);
  }

  public async managed(): Promise<Map<string, string>> {
    return new Map([...this.live.entries()].map(([handle, torrent]) => [torrent.tag, handle]));
  }
}

// ---------- Harness ---------- //

beforeAll(async () => {
  await migrateAuth();
  root = await mkdtemp(join(tmpdir(), "findr-pipeline-"));
  fixture = join(root, "fixture.mkv");
  if (hasTools) {
    await Bun.$`ffmpeg -loglevel error -y -f lavfi -i color=c=red:s=64x48:d=1 -f lavfi -i sine=d=1 -c:v libx264 -c:a aac ${fixture}`;
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of ["attempts", "candidates", "episodes", "downloads", "titles", "settings"]) {
    database.run(`DELETE FROM ${table}`);
  }
  for (const dir of ["downloads", "movies", "tv"]) {
    await rm(join(root, dir), { recursive: true, force: true });
    await mkdir(join(root, dir), { recursive: true });
  }
  SettingsStore.update({
    paths: { downloads: join(root, "downloads"), movies: join(root, "movies"), series: join(root, "tv") },
    watchdog: { pollIntervalSeconds: 1 },
    services: { tmdbApiKey: "test-tmdb-key", prowlarrUrl: "http://prowlarr.test:9696", prowlarrApiKey: "test-prowlarr-key" },
  });
  mockNetwork();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Creates a download and runs it to completion against the fake downloader. */
async function runDownload(
  downloader: FakeDownloader,
  tmdbId: number,
  mediaType: "movie" | "tv",
  season: number | null,
  signal = new AbortController().signal,
): Promise<Download> {
  const download = Download.create(Title.findOrCreate(tmdbId, mediaType), season, null);
  await new DownloadRunner(download, new AttemptRunner(downloader), signal).run();
  const reloaded = Download.find(download.id);
  if (!reloaded) throw new Error("download vanished");
  return reloaded;
}

/** Candidate statuses by title, for compact assertions. */
function candidateStatuses(downloadId: string): Record<string, string> {
  return Object.fromEntries(
    Candidate.forDownload(downloadId).map((candidate) => [
      candidate.title,
      candidate.toRecord().rejectionReason ? `${candidate.status}: ${candidate.toRecord().rejectionReason}` : candidate.status,
    ]),
  );
}

// ---------- Tests ---------- //

describe.skipIf(!hasTools)("download pipeline", () => {
  test("a movie skips a malicious release, saves the next best, and leaves no scratch files", async () => {
    const downloader = new FakeDownloader();
    const download = await runDownload(downloader, 603, "movie", null);

    expect(download.status).toBe("completed");
    expect(download.toSummary().result?.files).toEqual([join(root, "movies", "The Matrix (1999)", "The Matrix (1999).mkv")]);
    expect(candidateStatuses(download.id)).toEqual({
      "The.Matrix.1999.1080p.WEB-DL.x265-FLUX": "rejected: Contains a blocked file type: Codec.exe",
      "The.Matrix.1999.1080p.WEBRip.x264-GRP": "succeeded",
      "The.Matrix.1999.CAM.x264": "rejected: Blacklisted release type CAM",
    });
    expect(Attempt.forDownload(download.id).map((attempt) => attempt.toRecord().outcome)).toEqual(["succeeded", "failed"]);

    // Cleanup: no torrents left in the client, no scratch directories
    expect(downloader.live.size).toBe(0);
    expect(await readdir(join(root, "downloads"))).toEqual([]);
  });

  test("a season falls back to episodes when the pack is incomplete, and ends partial", async () => {
    const download = await runDownload(new FakeDownloader(), 100, "tv", 1);

    expect(download.status).toBe("partial");
    expect(download.toSummary().result?.episodes).toEqual({ completed: [1, 2], failed: [3], unaired: [4] });
    expect(Episode.forDownload(download.id).map((episode) => [episode.episodeNumber, episode.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
      [3, "failed"],
      [4, "unaired"],
    ]);
    expect(candidateStatuses(download.id)["Show.S01.1080p.WEB-DL.x265-GRP"]).toBe(
      "rejected: Incomplete season pack: missing E03",
    );
    expect((await readdir(join(root, "tv", "Show (2020)", "Season 01"))).sort()).toEqual([
      "Show - S01E01.mkv",
      "Show - S01E02.mkv",
    ]);
  });

  test("an unavailable client fails the download without blaming any release", async () => {
    const downloader = new FakeDownloader();
    downloader.unavailable = true;
    const download = await runDownload(downloader, 603, "movie", null);

    expect(download.status).toBe("failed");
    expect(download.toSummary().statusMessage).toBe("The torrent client is unavailable");
    expect(candidateStatuses(download.id)["The.Matrix.1999.1080p.WEB-DL.x265-FLUX"]).toBe("pending");
    expect(Attempt.forDownload(download.id)[0]?.toRecord().outcome).toBe("interrupted");
  });

  test("cancelling mid-download cleans up and releases the candidate", async () => {
    const downloader = new FakeDownloader();
    downloader.hang = true;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const download = await runDownload(downloader, 603, "movie", null, controller.signal);

    expect(download.status).toBe("cancelled");
    expect(Attempt.forDownload(download.id)[0]?.toRecord().outcome).toBe("cancelled");
    expect(downloader.live.size).toBe(0);
    expect(await readdir(join(root, "downloads"))).toEqual([]);
  });

  test("recovery closes interrupted attempts, removes their files and torrents, and resumes", async () => {
    // Simulate a crash: an open attempt, its scratch dir, and its torrent
    const downloader = new FakeDownloader();
    const download = Download.create(Title.findOrCreate(603, "movie"), null, null);
    download.setStatus("downloading");
    Candidate.insertMany([
      {
        downloadId: download.id, episodeId: null, title: "The.Matrix.1999.720p.WEB-DL.x264-OLD", indexer: "Fake",
        infoHash: null, magnetUri: "magnet:?xt=urn:btih:matrix-old", downloadUrl: null, sizeMB: 2048, seeders: 50,
        leechers: 1, publishedAt: null, score: 60, status: "pending", rejectionReason: null,
        parsed: new ReleaseParser().parse("The.Matrix.1999.720p.WEB-DL.x264-OLD"),
      },
    ]);
    const [stale] = Candidate.forDownload(download.id);
    if (!stale) throw new Error("candidate missing");
    stale.markAttempting();
    const attempt = Attempt.start({ downloadId: download.id, candidateId: stale.id, episodeId: null, run: 1 });
    const scratch = join(root, "downloads", download.id, stale.id, "payload");
    await mkdir(scratch, { recursive: true });
    await downloader.add({ kind: "magnet", uri: "magnet:?xt=urn:btih:matrix-old" }, { directory: scratch, tag: `findr-${attempt.id}` });

    // Recover with the fake client, then let the resumed download finish
    const queue = DownloadQueue.getInstance().useDownloader(downloader);
    await queue.recover();
    await queue.idle();

    expect(Attempt.forDownload(download.id).find((entry) => entry.id === attempt.id)?.toRecord()).toMatchObject({
      outcome: "interrupted",
      reason: "Interrupted by a server restart",
    });
    expect(Candidate.find(stale.id)?.toRecord().rejectionReason).toBe("Interrupted by a server restart");
    expect(downloader.live.size).toBe(0);

    // The resumed run found its stored candidates exhausted, searched once
    // more, skipped the malicious release and saved the good one
    const resumed = Download.find(download.id);
    expect(resumed?.status).toBe("completed");
    expect(candidateStatuses(download.id)["The.Matrix.1999.1080p.WEBRip.x264-GRP"]).toBe("succeeded");
    expect(await readdir(join(root, "downloads"))).toEqual([]);
  });
});
