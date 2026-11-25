import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { Attempt } from "../db/models/Attempt";
import { Candidate, type NewCandidate } from "../db/models/Candidate";
import { Download } from "../db/models/Download";
import { PlayLog } from "../db/models/PlayLog";
import { Title } from "../db/models/Title";
import { ReleaseParser } from "../releases/ReleaseParser";
import { AdminStats } from "./AdminStats";

const parser = new ReleaseParser();
const START = new Date("2026-03-02T10:00:00Z").getTime();
const MB = 1024 * 1024;

beforeAll(async () => {
  await migrateAuth();
});

beforeEach(() => {
  for (const table of ["play_log", "attempts", "candidates", "episodes", "downloads", "titles", "settings"]) database.run(`DELETE FROM ${table}`);
  setSystemTime(new Date(START));
});

afterEach(() => {
  setSystemTime();
});

/** A pending candidate from an indexer. */
function release(downloadId: string, indexer: string): NewCandidate {
  const title = "Movie.2024.1080p.WEB-DL.x264-GRP";
  return {
    downloadId,
    episodeId: null,
    title,
    indexer,
    infoHash: null,
    magnetUri: "magnet:?xt=urn:btih:abc",
    downloadUrl: null,
    sizeMB: 2048,
    seeders: 50,
    leechers: 5,
    publishedAt: null,
    parsed: parser.parse(title),
    score: 50,
    status: "pending",
    rejectionReason: null,
  };
}

/** Moves the clock on by `ms`. */
function wait(ms: number): void {
  setSystemTime(new Date(Date.now() + ms));
}

describe("Attempt timings", () => {
  test("record time spent in each phase and the bytes chosen", () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    Candidate.insertMany([release(download.id, "Alpha")]);
    const [candidate] = Candidate.forDownload(download.id);
    if (!candidate) throw new Error("candidate missing");

    const attempt = Attempt.start({ downloadId: download.id, candidateId: candidate.id, episodeId: null, run: 1 });
    wait(3_000);
    attempt.setBytes(600 * MB);
    attempt.setPhase("downloading");
    wait(60_000);
    attempt.setPhase("sterilizing");
    wait(20_000);
    attempt.setPhase("saving");
    wait(2_000);
    attempt.finish("succeeded");

    const [stored] = Attempt.forDownload(download.id);
    expect(stored?.bytes).toBe(600 * MB);
    expect(stored?.timings).toEqual({ metadata: 3_000, downloading: 60_000, sterilizing: 20_000, saving: 2_000 });
  });

  test("don't time an attempt picked up after a restart", () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    Candidate.insertMany([release(download.id, "Alpha")]);
    const [candidate] = Candidate.forDownload(download.id);
    if (!candidate) throw new Error("candidate missing");
    Attempt.start({ downloadId: download.id, candidateId: candidate.id, episodeId: null, run: 1 });

    wait(3_600_000);
    Attempt.unfinished()[0]?.finish("interrupted", "Interrupted by a server restart");
    expect(Attempt.forDownload(download.id)[0]?.timings).toEqual({});
  });
});

describe("AdminStats", () => {
  test("turns attempts into speeds, releases tried, drop reasons and indexer figures", async () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    Candidate.insertMany([release(download.id, "Alpha"), release(download.id, "Beta")]);
    const [first, second] = Candidate.forDownload(download.id);
    if (!first || !second) throw new Error("candidates missing");

    // The first release is too slow, the second downloads at 10 MB/s
    Attempt.start({ downloadId: download.id, candidateId: first.id, episodeId: null, run: 1 }).finish(
      "failed",
      "Too slow: averaged 12.0 KB/s over 5 min (minimum 50)",
    );
    const attempt = Attempt.start({ downloadId: download.id, candidateId: second.id, episodeId: null, run: 1 });
    attempt.setBytes(1000 * MB);
    attempt.setPhase("downloading");
    wait(100_000);
    attempt.setPhase("sterilizing");
    attempt.setPhase("saving");
    attempt.finish("succeeded");
    download.finish("completed", "Saved to the library");

    const stats = await new AdminStats().build("7d");
    expect(stats.downloads.requested).toBe(1);
    expect(stats.downloads.finished.map((row) => row.status)).toEqual(["completed"]);
    expect(stats.downloads.speeds[0]?.bytesPerSecond).toBeCloseTo(10 * MB);
    expect(stats.downloads.releasesTried.find((row) => row.releases === 2)?.count).toBe(1);
    expect(stats.downloads.dropReasons).toEqual([{ reason: "Downloading too slowly", count: 1 }]);
    expect(stats.downloads.timedReleases).toBe(1);
    expect(stats.downloads.indexers.map((row) => [row.name, row.tried, row.worked])).toEqual([
      ["Alpha", 1, 0],
      ["Beta", 1, 1],
    ]);
  });

  test("leaves out activity before the period", async () => {
    Download.create(Title.findOrCreate(1, "movie"), null, null);
    wait(10 * 86_400_000);
    const stats = await new AdminStats().build("7d");
    expect(stats.downloads.requested).toBe(0);
  });

  test("counts plays of a minute or more by how they were sent", async () => {
    const title = Title.findOrCreate(2, "tv");
    const play = { userId: null, titleId: title.id, season: 1, episode: 1, device: "browser" as const, rung: null, startedAt: START };
    PlayLog.record({ ...play, mode: "remux", endedAt: START + 30 * 60_000 });
    PlayLog.record({ ...play, mode: "transcode", rung: "device", endedAt: START + 10 * 60_000 });
    PlayLog.record({ ...play, mode: "audio", endedAt: START + 5_000 });

    const stats = await new AdminStats().build("30d");
    expect(stats.playback.plays).toBe(2);
    expect(stats.playback.delivery.map((row) => row.kind).sort()).toEqual(["copied", "video"]);
    expect(stats.playback.rungs).toEqual([{ rung: "device", count: 1 }]);
  });
});
