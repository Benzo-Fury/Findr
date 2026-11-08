/**
 * TheIntroDB (theintrodb.org): a free, community-checked database of where
 * intros, recaps and credits fall in TV episodes, looked up by TMDB id with
 * season and episode. Reads need no key. Findr asks it first for an
 * episode's credits, as its times are exact where a show is covered.
 */

import { version as packageVersion } from "../../../../../../package.json";

/** How long a lookup may take before Findr carries on without it. */
const TIMEOUT_MS = 6000;

/** Credits that start before this share of the runtime are a mid-episode segment, not the end credits. */
const END_SHARE = 0.5;

/** One segment as TheIntroDB gives it; `end_ms` null runs to the end, and 0 means no segment. */
interface Segment {
  start_ms?: number | null;
  end_ms?: number | null;
}

/** TheIntroDB couldn't be asked (offline, rate-limited or failing), as opposed to having no data. */
export class TheIntroDbUnavailableError extends Error {
  constructor(message: string) {
    super(`TheIntroDB unavailable: ${message}`);
    this.name = "TheIntroDbUnavailableError";
  }
}

export class TheIntroDb {
  /** The API's address; tests point it at a fake. */
  public static baseUrl = "https://api.theintrodb.org/v4";

  /**
   * Where an episode's end credits start, in milliseconds, or null when
   * TheIntroDB has none for it. `durationMs` lets it pick the times of the
   * release that matches the file. Throws `TheIntroDbUnavailableError` when
   * it can't be asked, so the caller can try again later.
   */
  public static async credits(tmdbId: number, season: number, episode: number, durationMs: number): Promise<number | null> {
    const url = `${this.baseUrl}/media?tmdb_id=${tmdbId}&season=${season}&episode=${episode}&duration_ms=${Math.round(durationMs)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": `Findr/${process.env.FINDR_VERSION ?? packageVersion}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new TheIntroDbUnavailableError(error instanceof Error ? error.message : String(error));
    }

    // Not found (no submissions, unknown episode or show) is an answer; anything else is a failure
    if (response.status === 404) return null;
    if (!response.ok) throw new TheIntroDbUnavailableError(`HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as unknown;
    return this.parse(body, durationMs);
  }

  /**
   * The end credits' start in a `/media` answer: the earliest credits
   * segment in the second half of the runtime, ignoring empty segments and
   * any that start past the end of the file.
   */
  public static parse(body: unknown, durationMs: number): number | null {
    const credits = typeof body === "object" && body !== null ? (body as { credits?: unknown }).credits : undefined;
    if (!Array.isArray(credits)) return null;

    const starts = (credits as Segment[])
      .filter((segment) => segment.end_ms !== 0 && typeof segment.start_ms === "number")
      .map((segment) => segment.start_ms as number)
      .filter((start) => start >= durationMs * END_SHARE && start < durationMs);
    return starts.length > 0 ? Math.round(Math.min(...starts)) : null;
  }
}
