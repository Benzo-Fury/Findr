import { describe, expect, test } from "bun:test";
import { PreferencesSchema } from "@findr/types/settings";
import { ReleaseParser } from "./ReleaseParser";
import { ReleaseScorer, type ScoreResult, type ScoreTarget } from "./ReleaseScorer";

const parser = new ReleaseParser();
const preferences = PreferencesSchema.parse({});
const now = new Date("2026-01-01T00:00:00Z");

/** Parses a title and scores it against a target with sensible swarm defaults. */
function evaluate(
  title: string,
  target: ScoreTarget,
  overrides: { sizeMB?: number; seeders?: number } = {},
): ScoreResult {
  const scorer = new ReleaseScorer(target, preferences, now);
  return scorer.evaluate({
    parsed: parser.parse(title),
    sizeMB: overrides.sizeMB ?? 4096,
    seeders: overrides.seeders ?? 100,
    publishedAt: null,
  });
}

/** Unwraps an accepted result's score, failing the test if it was rejected. */
function scoreOf(result: ScoreResult): number {
  if (!result.accepted) throw new Error(`Expected acceptance, got rejection: ${result.reason}`);
  return result.score;
}

const movie: ScoreTarget = { kind: "movie", year: 2024 };
const season2: ScoreTarget = { kind: "season", season: 2, episodeCount: 10 };
const episode: ScoreTarget = { kind: "episode", season: 1, episode: 4 };

// ---------- Hard filters ---------- //

describe("hard filters", () => {
  test("rejects blacklisted release types", () => {
    const result = evaluate("Deadpool.and.Wolverine.2024.1080p.HDCAM.x264", movie);
    expect(result).toEqual({ accepted: false, reason: "Blacklisted release type CAM" });
  });

  test("rejects releases below the seeder minimum", () => {
    const result = evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie, { seeders: 2 });
    expect(result.accepted).toBe(false);
  });

  test("rejects movies over the size ceiling", () => {
    const result = evaluate("Movie.2024.2160p.BluRay.REMUX-GRP", movie, { sizeMB: 60_000 });
    expect(result.accepted).toBe(false);
  });

  test("scales the size ceiling across a season pack's episodes", () => {
    // 40 GB over 10 episodes is 4 GB each, inside the 10 GB limit
    const result = evaluate("Severance.S02.1080p.WEB-DL.x264-FLUX", season2, { sizeMB: 40_960 });
    expect(result.accepted).toBe(true);
  });

  test("rejects a movie from a different year", () => {
    const result = evaluate("Dune.1984.1080p.BluRay.x264-GRP", movie);
    expect(result).toEqual({ accepted: false, reason: "Release year 1984 does not match 2024" });
  });

  test("rejects TV releases for a movie target", () => {
    expect(evaluate("Dune.Prophecy.S01E01.1080p.WEB-DL.x264", movie).accepted).toBe(false);
  });

  test("season targets accept only a pack of that exact season", () => {
    expect(evaluate("Severance.S02.1080p.WEB-DL.x264-FLUX", season2, { sizeMB: 20_000 }).accepted).toBe(true);
    expect(evaluate("Severance.S01.1080p.WEB-DL.x264-FLUX", season2).accepted).toBe(false);
    expect(evaluate("Severance.S02E01.1080p.WEB-DL.x264-FLUX", season2).accepted).toBe(false);
    expect(evaluate("Severance.S01-S02.1080p.WEB-DL.x264-FLUX", season2).accepted).toBe(false);
    expect(evaluate("Severance.The.Complete.Series.1080p.WEB-DL", season2).accepted).toBe(false);
  });

  test("episode targets accept only that one episode", () => {
    expect(evaluate("Show.S01E04.1080p.WEB-DL.x264-GRP", episode, { sizeMB: 1200 }).accepted).toBe(true);
    expect(evaluate("Show.S01E05.1080p.WEB-DL.x264-GRP", episode).accepted).toBe(false);
    expect(evaluate("Show.S01E03E04.1080p.WEB-DL.x264-GRP", episode).accepted).toBe(false);
    expect(evaluate("Show.S01.1080p.WEB-DL.x264-GRP", episode).accepted).toBe(false);
  });
});

// ---------- Ranking ---------- //

describe("ranking", () => {
  test("prefers the user's first-choice resolution", () => {
    const hd = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x265-FLUX", movie));
    const sd = scoreOf(evaluate("Movie.2024.720p.WEB-DL.x265-FLUX", movie));
    expect(hd).toBeGreaterThan(sd);
  });

  test("prefers sizes near the ideal over bloated ones", () => {
    const ideal = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie, { sizeMB: 4096 }));
    const bloated = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie, { sizeMB: 9_500 }));
    expect(ideal).toBeGreaterThan(bloated);
  });

  test("judges episode sizes against the episode ideal, not the movie one", () => {
    const right = scoreOf(evaluate("Show.S01E04.1080p.WEB-DL.x264-GRP", episode, { sizeMB: 1200 }));
    const movieSized = scoreOf(evaluate("Show.S01E04.1080p.WEB-DL.x264-GRP", episode, { sizeMB: 4096 }));
    expect(right).toBeGreaterThan(movieSized);
  });

  test("more seeders score higher, with diminishing returns", () => {
    const few = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie, { seeders: 10 }));
    const many = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie, { seeders: 500 }));
    const huge = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie, { seeders: 5000 }));
    expect(many).toBeGreaterThan(few);
    expect(huge - many).toBeLessThan(many - few);
  });

  test("gives a small edge to repacks", () => {
    const plain = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-GRP", movie));
    const repack = scoreOf(evaluate("Movie.2024.REPACK.1080p.WEB-DL.x264-GRP", movie));
    expect(repack).toBeGreaterThan(plain);
  });

  test("rewards reputable groups regardless of case", () => {
    const known = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-Ntb", movie));
    const unknown = scoreOf(evaluate("Movie.2024.1080p.WEB-DL.x264-RandomGuy", movie));
    expect(known).toBeGreaterThan(unknown);
  });
});
