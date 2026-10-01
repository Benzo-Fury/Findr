import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrateAuth } from "../../auth/client";
import { ReleaseParser } from "../../releases/ReleaseParser";
import { database } from "../client";
import { migrations } from "../migrations";
import { AppState } from "./AppState";
import { Attempt } from "./Attempt";
import { Candidate, type NewCandidate } from "./Candidate";
import { Download } from "./Download";
import { Episode } from "./Episode";
import { SettingsStore } from "./SettingsStore";
import { Title } from "./Title";

const parser = new ReleaseParser();

/** Downloads reference BetterAuth's user table, which must exist before any write. */
beforeAll(async () => {
  await migrateAuth();
});

/** Wipes every application table between tests; the in-memory schema stays. */
beforeEach(() => {
  for (const table of ["attempts", "candidates", "episodes", "downloads", "titles", "settings"]) {
    database.run(`DELETE FROM ${table}`);
  }
});

/** A candidate with sensible defaults for a download. */
function candidate(downloadId: string, overrides: Partial<NewCandidate> = {}): NewCandidate {
  const title = overrides.title ?? "Movie.2024.1080p.WEB-DL.x264-GRP";
  return {
    downloadId,
    episodeId: null,
    title,
    indexer: "Test",
    infoHash: null,
    magnetUri: "magnet:?xt=urn:btih:abc",
    downloadUrl: null,
    sizeMB: 4096,
    seeders: 50,
    leechers: 5,
    publishedAt: null,
    parsed: parser.parse(title),
    score: 50,
    status: "pending",
    rejectionReason: null,
    ...overrides,
  };
}

describe("migrations", () => {
  test("record the applied schema version", () => {
    const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(row?.user_version).toBe(migrations.length);
  });
});

describe("AppState", () => {
  test("stores JSON documents by key and reads unset keys as null", () => {
    expect(AppState.get("test.nodes")).toBeNull();

    AppState.set("test.nodes", [{ host: "203.0.113.5", port: 6881 }]);
    expect(AppState.get("test.nodes")).toEqual([{ host: "203.0.113.5", port: 6881 }]);

    AppState.set("test.nodes", []);
    expect(AppState.get("test.nodes")).toEqual([]);
  });
});

describe("Title", () => {
  test("findOrCreate is idempotent per TMDB identity", () => {
    const first = Title.findOrCreate(603, "movie");
    const again = Title.findOrCreate(603, "movie");
    const show = Title.findOrCreate(603, "tv");
    expect(again.id).toBe(first.id);
    expect(show.id).not.toBe(first.id);
  });

  test("lists only titles with downloads, filtered and paginated", () => {
    const withDownload = Title.findOrCreate(1, "movie");
    Title.findOrCreate(2, "movie");
    Download.create(withDownload, null, null);

    const page = Title.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(withDownload.id);
    expect(Title.list({ page: 1, pageSize: 10, tmdbId: 2 }).total).toBe(0);
  });

  test("deleting a title cascades to everything beneath it", () => {
    const title = Title.findOrCreate(1, "movie");
    const download = Download.create(title, null, null);
    Candidate.insertMany([candidate(download.id)]);
    title.delete();
    expect(Download.find(download.id)).toBeNull();
    expect(Candidate.forDownload(download.id)).toHaveLength(0);
  });
});

describe("Download", () => {
  test("tracks unfinished downloads per title and season", () => {
    const title = Title.findOrCreate(1399, "tv");
    const download = Download.create(title, 1, null);
    expect(Download.findUnfinished(title.id, 1)?.id).toBe(download.id);
    expect(Download.findUnfinished(title.id, 2)).toBeNull();

    download.recordSavedFiles(["/lib/a.mkv"]);
    download.finish("completed", "Saved");
    expect(Download.findUnfinished(title.id, 1)).toBeNull();
    expect(Download.find(download.id)?.toSummary().result).toEqual({ files: ["/lib/a.mkv"] });
  });

  test("a new run re-queues and increments the run counter", () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    download.finish("failed", "No candidates");
    download.startNewRun();
    const reloaded = Download.find(download.id);
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.run).toBe(2);
  });

  test("filters by active and finished state", () => {
    const title = Title.findOrCreate(1, "movie");
    Download.create(title, null, null);
    Download.create(Title.findOrCreate(2, "movie"), null, null).finish("failed", null);
    expect(Download.list({ page: 1, pageSize: 10, state: "active" }).total).toBe(1);
    expect(Download.list({ page: 1, pageSize: 10, state: "finished" }).total).toBe(1);
  });
});

describe("Candidate", () => {
  test("pendingFor ranks pinned first, then by score, per unit", () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    Candidate.insertMany([
      candidate(download.id, { title: "Low.2024.720p.WEB-DL", score: 10 }),
      candidate(download.id, { title: "High.2024.1080p.WEB-DL", score: 90 }),
      candidate(download.id, { title: "Rejected.2024.CAM", score: null, status: "rejected", rejectionReason: "CAM" }),
    ]);

    const [best, second] = Candidate.pendingFor(download.id, null);
    expect(best?.title).toBe("High.2024.1080p.WEB-DL");

    second?.reject("Stalled");
    second?.requeue(true);
    expect(Candidate.pendingFor(download.id, null)[0]?.title).toBe("Low.2024.720p.WEB-DL");
  });

  test("records never expose download links", () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    Candidate.insertMany([candidate(download.id, { downloadUrl: "http://prowlarr/1/download?link=x" })]);
    const [stored] = Candidate.forDownload(download.id);
    const record = JSON.stringify(stored?.toRecord());
    expect(record).not.toContain("magnet:");
    expect(record).not.toContain("prowlarr");
    expect(stored?.source().downloadUrl).toBe("http://prowlarr/1/download?link=x");
  });

  test("separates season-pack and per-episode candidates", () => {
    const download = Download.create(Title.findOrCreate(1399, "tv"), 1, null);
    const [episode] = Episode.ensure(download.id, [{ number: 1, status: "pending" }]);
    Candidate.insertMany([
      candidate(download.id, { title: "Show.S01.1080p" }),
      candidate(download.id, { title: "Show.S01E01.1080p", episodeId: episode?.id ?? null }),
    ]);
    expect(Candidate.pendingFor(download.id, null)).toHaveLength(1);
    expect(Candidate.pendingFor(download.id, episode?.id ?? null)[0]?.title).toBe("Show.S01E01.1080p");
    expect(Candidate.existsFor(download.id, episode?.id ?? null)).toBe(true);
  });
});

describe("Episode", () => {
  test("ensure keeps existing episode state", () => {
    const download = Download.create(Title.findOrCreate(1399, "tv"), 1, null);
    const [first] = Episode.ensure(download.id, [{ number: 1, status: "pending" }]);
    first?.setStatus("completed");
    const again = Episode.ensure(download.id, [
      { number: 1, status: "pending" },
      { number: 2, status: "unaired" },
    ]);
    expect(again.map((episode) => [episode.episodeNumber, episode.status])).toEqual([
      [1, "completed"],
      [2, "unaired"],
    ]);
  });
});

describe("Attempt", () => {
  test("counts failures per unit and run, and finds unfinished attempts", () => {
    const download = Download.create(Title.findOrCreate(1, "movie"), null, null);
    Candidate.insertMany([candidate(download.id), candidate(download.id)]);
    const [a, b] = Candidate.forDownload(download.id);
    if (!a || !b) throw new Error("candidates missing");

    Attempt.start({ downloadId: download.id, candidateId: a.id, episodeId: null, run: 1 }).finish("failed", "Stalled");
    const live = Attempt.start({ downloadId: download.id, candidateId: b.id, episodeId: null, run: 1 });
    live.setPhase("downloading", 0.4);

    expect(Attempt.failuresFor(download.id, null, 1)).toBe(1);
    expect(Attempt.failuresFor(download.id, null, 2)).toBe(0);
    expect(Attempt.unfinished().map((attempt) => attempt.id)).toEqual([live.id]);
    expect(download.toSummary().activeAttempt).toMatchObject({ phase: "downloading", progress: 0.4 });
  });
});

describe("SettingsStore", () => {
  test("loads defaults from an empty store", () => {
    const settings = SettingsStore.load();
    expect(settings.queue.maxAttempts).toBe(5);
    expect(settings.naming.seasonFolder).toBe("Season {season}");
  });

  test("merges patches field by field and persists them", () => {
    SettingsStore.update({ watchdog: { stallTimeoutMinutes: 3 } });
    SettingsStore.update({ watchdog: { minSpeedKBps: 0 } });
    const settings = SettingsStore.load();
    expect(settings.watchdog.stallTimeoutMinutes).toBe(3);
    expect(settings.watchdog.minSpeedKBps).toBe(0);
    expect(settings.watchdog.metadataTimeoutMinutes).toBe(5);
  });

  test("rejects an invalid patch without writing anything", () => {
    expect(() => SettingsStore.update({ paths: { movies: "relative/path" } })).toThrow();
    expect(SettingsStore.load().paths.movies).toBe("");
  });
});
