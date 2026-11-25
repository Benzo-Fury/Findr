/**
 * Where an episode's end credits start, so players can offer the next
 * episode then rather than at the very end. TheIntroDB is asked first; for
 * episodes it doesn't cover, the file's ending is matched by audio against
 * the neighbouring episodes', then scanned for black frames.
 *
 * Answers are kept on the media item. TheIntroDB's are final; one found
 * locally, or none, is looked up again after a week in case TheIntroDB has
 * it by then, and one found while TheIntroDB couldn't be asked, after an
 * hour. Lookups for the same item share one promise, and only one file is
 * read at a time, so a season opened at once doesn't load the server.
 */

import { MediaItem, type CreditsSource } from "../../db/models/MediaItem";
import { Title } from "../../db/models/Title";
import SelfManagedSingleton from "../../other/SelfManagedSingleton";
import { CreditsDetector, POINT_SECONDS } from "./CreditsDetector";
import { TheIntroDb, TheIntroDbUnavailableError } from "./TheIntroDb";

/** When to look again for credits found locally, or not found. */
const RETRY_LOCAL_MS = 7 * 24 * 60 * 60_000;

/** When to look again after TheIntroDB couldn't be asked. */
const RETRY_UNAVAILABLE_MS = 60 * 60_000;

/** How long reading one episode's ending (and its neighbours') may take. */
const DETECT_TIMEOUT_MS = 120_000;

/** Fingerprints kept in memory, so neighbours aren't read again for each episode of a season. */
const FINGERPRINT_CACHE = 48;

/** What a lookup found. */
interface Found {
  creditsMs: number | null;
  source: CreditsSource;
}

export default class CreditsLocator extends SelfManagedSingleton {
  /** Lookups running, by item id. */
  private readonly running = new Map<string, Promise<number | null>>();
  /** Recent fingerprints by item id; null for an item that has none. */
  private readonly fingerprints = new Map<string, Uint32Array | null>();
  /** The file being read now; the next waits for it. */
  private reading: Promise<unknown> = Promise.resolve();

  /** Where an episode's credits start, in milliseconds; null for a movie or when they can't be found. */
  public creditsOf(item: MediaItem): Promise<number | null> {
    if (item.season === null || item.episode === null) return Promise.resolve(null);
    const fresh = item.creditsSource !== null && (item.creditsRetryAt === null || item.creditsRetryAt > Date.now());
    if (fresh) return Promise.resolve(item.creditsMs);

    let lookup = this.running.get(item.id);
    if (!lookup) {
      lookup = this.locate(item)
        .catch((error: unknown) => {
          console.warn(`[Playback] Couldn't look for the credits of ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
          return item.creditsMs;
        })
        .finally(() => this.running.delete(item.id));
      this.running.set(item.id, lookup);
    }
    return lookup;
  }

  // ---------- Lookup ---------- //

  /** Asks TheIntroDB, then the file, and records the answer. */
  private async locate(item: MediaItem): Promise<number | null> {
    const season = item.season ?? 0;
    const episode = item.episode ?? 0;
    const title = Title.find(item.titleId);

    // TheIntroDB, when the show is known
    let unavailable = false;
    if (title) {
      try {
        const creditsMs = await TheIntroDb.credits(title.tmdbId, season, episode, item.durationMs);
        if (creditsMs !== null) return this.record(item, { creditsMs, source: "theintrodb" }, null);
      } catch (error) {
        if (!(error instanceof TheIntroDbUnavailableError)) throw error;
        unavailable = true;
      }
    }
    const retryAt = Date.now() + (unavailable ? RETRY_UNAVAILABLE_MS : RETRY_LOCAL_MS);

    // Found locally before: the file hasn't changed, so neither has the answer
    if (item.creditsSource === "fingerprint" || item.creditsSource === "blackframe") return this.record(item, { creditsMs: item.creditsMs, source: item.creditsSource }, retryAt);

    // The file itself, one at a time
    const found = await this.exclusive(() => this.detect(item));
    return this.record(item, found, retryAt);
  }

  /** Reads the ending: audio against the neighbouring episodes first, then black frames. */
  private async detect(item: MediaItem): Promise<Found> {
    const signal = AbortSignal.timeout(DETECT_TIMEOUT_MS);
    const own = await this.fingerprintOf(item, signal);

    // The episodes either side in the same season, nearest first
    if (own) {
      const season = MediaItem.episodesOf(item.titleId).filter((other) => other.season === item.season);
      const index = season.findIndex((other) => other.id === item.id);
      const neighbours = [season[index + 1], season[index - 1]].filter((other): other is MediaItem => other !== undefined);
      for (const neighbour of neighbours) {
        const theirs = await this.fingerprintOf(neighbour, signal);
        const match = theirs ? CreditsDetector.match(own, theirs) : null;
        if (match) {
          const creditsMs = Math.round((CreditsDetector.windowStart(item) + match.a * POINT_SECONDS) * 1000);
          return { creditsMs, source: "fingerprint" };
        }
      }
    }

    // Credits on black
    const creditsMs = await CreditsDetector.blackFrames(item, signal);
    return creditsMs !== null ? { creditsMs, source: "blackframe" } : { creditsMs: null, source: "none" };
  }

  // ---------- Helpers ---------- //

  /** An item's fingerprint, from memory when recent. */
  private async fingerprintOf(item: MediaItem, signal: AbortSignal): Promise<Uint32Array | null> {
    if (this.fingerprints.has(item.id)) return this.fingerprints.get(item.id) ?? null;
    const points = await CreditsDetector.fingerprint(item, signal);

    // Oldest out first once the cache is full
    this.fingerprints.set(item.id, points);
    if (this.fingerprints.size > FINGERPRINT_CACHE) {
      const oldest = this.fingerprints.keys().next().value;
      if (oldest !== undefined) this.fingerprints.delete(oldest);
    }
    return points;
  }

  /** Saves an answer on the item and logs it. */
  private record(item: MediaItem, found: Found, retryAt: number | null): number | null {
    MediaItem.setCredits(item.id, found.creditsMs, found.source, retryAt);
    if (found.source !== item.creditsSource || found.creditsMs !== item.creditsMs) {
      const where = found.creditsMs === null ? "not found" : `at ${CreditsLocator.clock(found.creditsMs)} (${found.source})`;
      console.info(`[Playback] Credits of S${item.season}E${item.episode} of title ${item.titleId}: ${where}`);
    }
    return found.creditsMs;
  }

  /** Runs `work` once the file being read before it is done. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.reading.then(work, work);
    this.reading = result.catch(() => {});
    return result;
  }

  /** `H:MM:SS`, for logs. */
  private static clock(ms: number): string {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
}
