/**
 * Runs one download from start to finish.
 *
 * A download breaks into units of work: the movie itself, or for a season
 * first the whole-season pack and then, if no complete pack succeeds, each
 * aired episode on its own. Every unit gets the same treatment:
 *
 *   search once   Prowlarr → parse → score → relevance filter → candidates
 *   attempt loop  best pending candidate → download → inspect → sterilize → save
 *                 on a bad release: reject it with the reason and try the next
 *                 stop after the configured number of failed attempts
 *
 * Retries walk the stored candidates rather than searching again. The only
 * re-search is a single one per run for a unit whose stored candidates are
 * already exhausted — a retried download picks up releases published since.
 *
 * Everything is persisted as it happens, so a restart resumes from the
 * database: finished units are skipped and in-flight attempts are discarded.
 */

import type { MediaType } from "@findr/types/media";
import type { Settings } from "@findr/types/settings";
import { Attempt } from "../db/models/Attempt";
import { Candidate } from "../db/models/Candidate";
import type { Download } from "../db/models/Download";
import { Episode } from "../db/models/Episode";
import { SettingsStore } from "../db/models/SettingsStore";
import type { InspectionTarget } from "../downloader/FileInspector";
import type { TitleNaming } from "../media/LibrarySaver";
import type { TitleQuery } from "../prowlarr/Prowlarr";
import type { ScoreTarget } from "../releases/ReleaseScorer";
import TMDB, { type SeasonEpisode, type TitleFacts } from "../tmdb/TMDB";
import type { AttemptResult, AttemptRunner } from "./AttemptRunner";
import { CandidateSearch } from "./CandidateSearch";
import { AttemptFailure, CancelledError, FatalDownloadError, SuspendedError, throwIfCancelled } from "./errors";
import type { RelevanceContext } from "./RelevanceFilter";

// ---------- Types ---------- //

/** One independently searched and attempted piece of a download. */
interface WorkUnit {
  /** Null for the movie and the season pack. */
  episode: Episode | null;
  /** Human-readable name for status messages. */
  label: string;
  query: TitleQuery;
  target: ScoreTarget;
  inspection: InspectionTarget;
}

type UnitOutcome = { ok: true; result: AttemptResult } | { ok: false; reason: string };

/** Facts shared by every unit of the download. */
interface DownloadContext {
  facts: TitleFacts;
  naming: TitleNaming;
  relevance: RelevanceContext;
}

// ---------- Constants ---------- //

/** What a user sees when a download fails on a bug rather than a known problem. */
const UNEXPECTED_FAILURE = "Something went wrong inside Findr. Retry the download; if it keeps failing, check the server log.";

// ---------- Runner ---------- //

export class DownloadRunner {
  /** Units searched during this run; each is searched at most once per run. */
  private readonly searched = new Set<string>();
  private readonly search = new CandidateSearch();

  constructor(
    private readonly download: Download,
    private readonly attempts: AttemptRunner,
    private readonly signal: AbortSignal,
  ) {}

  /**
   * Runs the download to a final status. Never throws: every outcome, including
   * cancellation and unexpected errors, ends up recorded on the download.
   */
  public async run(): Promise<void> {
    try {
      const context = await this.context();
      if (this.download.mediaType === "movie") {
        await this.runMovie(context);
      } else {
        await this.runSeason(context);
      }
    } catch (error) {
      this.recordFailure(error);
    }
  }

  // ---------- Movies ---------- //

  /** A movie is a single unit. */
  private async runMovie(context: DownloadContext): Promise<void> {
    const outcome = await this.runUnit(context, {
      episode: null,
      label: "Movie",
      query: this.query(context, {}),
      target: { kind: "movie", year: context.facts.year },
      inspection: { kind: "movie" },
    });

    if (outcome.ok) {
      this.download.finish("completed", "Saved to the library");
    } else {
      this.download.finish("failed", outcome.reason);
    }
  }

  // ---------- Seasons ---------- //

  /**
   * Tries a complete season pack first — one torrent is faster and kinder to
   * the swarm — then fetches whatever is still missing episode by episode.
   * Episodes that have not aired are skipped rather than failed.
   */
  private async runSeason(context: DownloadContext): Promise<void> {
    const season = this.download.season ?? 0;

    // Establish which episodes exist and which have aired
    const episodes = await this.planEpisodes(season);
    const aired = episodes.filter((episode) => episode.status !== "unaired");
    if (aired.length === 0) {
      this.download.finish("failed", `No episodes of season ${season} have aired yet`, this.tally(episodes));
      return;
    }
    const airedNumbers = aired.map((episode) => episode.episodeNumber);
    const missing = () => aired.filter((episode) => episode.status !== "completed");

    // Season pack: only while nothing is saved yet, unless a user pinned a pack
    const pinnedPack = Candidate.pendingFor(this.download.id, null).some((candidate) => candidate.pinned);
    let packNote: string | null = null;
    if (missing().length === aired.length || pinnedPack) {
      const outcome = await this.runUnit(context, {
        episode: null,
        label: `Season ${season} pack`,
        query: this.query(context, { season }),
        target: { kind: "season", season, episodeCount: aired.length },
        inspection: { kind: "season", season, requiredEpisodes: airedNumbers },
      });

      if (outcome.ok) {
        for (const episode of aired) {
          if (outcome.result.episodes.includes(episode.episodeNumber)) episode.setStatus("completed");
        }
      } else {
        packNote = outcome.reason;
      }
    }

    // Fall back to fetching each missing episode on its own
    for (const episode of missing()) {
      throwIfCancelled(this.signal);
      const code = this.episodeCode(season, episode.episodeNumber);
      episode.setStatus("searching");

      const outcome = await this.runUnit(context, {
        episode,
        label: code,
        query: this.query(context, { season, episode: episode.episodeNumber }),
        target: { kind: "episode", season, episode: episode.episodeNumber },
        inspection: { kind: "episode", season, episode: episode.episodeNumber },
      });

      if (outcome.ok) {
        episode.setStatus("completed");
      } else {
        episode.setStatus("failed", outcome.reason);
      }
    }

    // Summarise by how many aired episodes made it
    const tally = this.tally(episodes);
    const saved = tally.completed.length;
    if (saved === aired.length) {
      this.download.finish("completed", `Saved all ${saved} aired episode(s)`, tally);
    } else if (saved > 0) {
      this.download.finish("partial", `Saved ${saved} of ${aired.length} aired episodes`, tally);
    } else {
      this.download.finish("failed", packNote ?? "No episode could be downloaded", tally);
    }
  }

  /**
   * Records the season's episodes from TMDB. Episodes already tracked keep
   * their status, except that an episode which was unaired and has since
   * aired becomes pending, and episodes a restart left mid-flight go back to
   * pending.
   */
  private async planEpisodes(season: number): Promise<Episode[]> {
    let listed: SeasonEpisode[];
    try {
      listed = await TMDB.getInstance().seasonEpisodes(this.download.tmdbId, season);
    } catch (error) {
      throw new FatalDownloadError(`Could not load season ${season} from TMDB: ${this.message(error)}`);
    }
    if (listed.length === 0) throw new FatalDownloadError(`TMDB lists no episodes for season ${season}`);

    // Anything dated today or earlier has aired
    const today = new Date().toISOString().slice(0, 10);
    const hasAired = (episode: SeasonEpisode) => episode.airDate !== null && episode.airDate <= today;
    const airedNumbers = new Set(listed.filter(hasAired).map((episode) => episode.number));

    const episodes = Episode.ensure(
      this.download.id,
      listed.map((episode) => ({ number: episode.number, status: hasAired(episode) ? "pending" : "unaired" })),
    );

    // Reconcile statuses carried over from earlier runs
    for (const episode of episodes) {
      const nowAired = airedNumbers.has(episode.episodeNumber);
      if (episode.status === "unaired" && nowAired) episode.setStatus("pending");
      if (episode.status === "searching" || episode.status === "downloading") episode.setStatus("pending");
    }
    return episodes;
  }

  // ---------- Attempt loop ---------- //

  /**
   * Searches for a unit if needed, then walks its candidates best-first until
   * one succeeds, the candidates run out, or the attempt limit is reached.
   */
  private async runUnit(context: DownloadContext, unit: WorkUnit): Promise<UnitOutcome> {
    const episodeId = unit.episode?.id ?? null;
    const settings = SettingsStore.load();
    let lastFailure: string | null = null;

    // Search the first time this unit is reached
    if (!Candidate.existsFor(this.download.id, episodeId)) await this.searchUnit(context, unit, settings);

    while (true) {
      throwIfCancelled(this.signal);

      // Stop once this run has used its attempts for the unit
      const failures = Attempt.failuresFor(this.download.id, episodeId, this.download.run);
      if (failures >= settings.queue.maxAttempts) {
        return { ok: false, reason: `Gave up after ${failures} failed attempt(s)${lastFailure ? ` — last: ${lastFailure}` : ""}` };
      }

      // Take the best untried candidate, searching once more if none are left
      const [candidate] = Candidate.pendingFor(this.download.id, episodeId);
      if (!candidate) {
        if (!this.searched.has(this.unitKey(unit))) {
          await this.searchUnit(context, unit, settings);
          continue;
        }
        return { ok: false, reason: lastFailure ? `No releases left to try — last: ${lastFailure}` : "No eligible releases found" };
      }

      // Try it
      const outcome = await this.attempt(context, unit, candidate, settings);
      if (outcome.ok) return outcome;
      lastFailure = outcome.reason;
    }
  }

  /**
   * Runs one attempt and records how it ended. A bad release is rejected and
   * reported back to the loop; cancellation, the killswitch and environment
   * failures put the candidate back untouched and propagate, since no other
   * candidate would fare better.
   */
  private async attempt(
    context: DownloadContext,
    unit: WorkUnit,
    candidate: Candidate,
    settings: Settings,
  ): Promise<UnitOutcome> {
    const attempt = Attempt.start({
      downloadId: this.download.id,
      candidateId: candidate.id,
      episodeId: unit.episode?.id ?? null,
      run: this.download.run,
    });
    candidate.markAttempting();
    unit.episode?.setStatus("downloading");
    this.download.setStatus("downloading", `${unit.label}: ${candidate.title}`);

    try {
      const result = await this.attempts.run({
        downloadId: this.download.id,
        mediaType: this.download.mediaType,
        season: this.download.season,
        candidate,
        attempt,
        inspection: unit.inspection,
        naming: context.naming,
        settings,
        signal: this.signal,
      });

      // Success: record the files right away so a restart cannot lose them
      candidate.markSucceeded();
      attempt.finish("succeeded");
      this.download.recordSavedFiles(result.files);
      return { ok: true, result };
    } catch (error) {
      // The release was bad; move on to the next one
      if (error instanceof AttemptFailure) {
        candidate.reject(error.message);
        attempt.finish("failed", error.message);
        return { ok: false, reason: error.message };
      }

      // Not the release's fault: put it back and stop the download
      candidate.release();
      if (error instanceof CancelledError) {
        attempt.finish("cancelled");
        throw error;
      }
      if (error instanceof SuspendedError) {
        attempt.finish("interrupted", `Paused by the VPN killswitch: ${error.message}`);
        throw error;
      }
      attempt.finish("interrupted", this.message(error));
      throw error instanceof FatalDownloadError ? error : new FatalDownloadError(UNEXPECTED_FAILURE, { cause: error });
    }
  }

  /** Searches for a unit and records that it was searched this run. */
  private async searchUnit(context: DownloadContext, unit: WorkUnit, settings: Settings): Promise<void> {
    this.download.setStatus("searching", `Searching indexers for ${unit.label.toLowerCase()}`);
    const summary = await this.search.run({
      downloadId: this.download.id,
      episodeId: unit.episode?.id ?? null,
      query: unit.query,
      target: unit.target,
      relevance: context.relevance,
      settings,
    });
    this.searched.add(this.unitKey(unit));
    console.log(`[Download ${this.download.id}] ${unit.label}: ${summary.found} release(s), ${summary.eligible} eligible`);
  }

  // ---------- Context ---------- //

  /** Looks the title up on TMDB once, for searching, filtering and naming. */
  private async context(): Promise<DownloadContext> {
    this.download.setStatus("searching", "Looking up the title");

    let facts: TitleFacts;
    try {
      facts = await TMDB.getInstance().titleFacts(this.download.mediaType, this.download.tmdbId);
    } catch (error) {
      throw new FatalDownloadError(`Could not look up the title on TMDB: ${this.message(error)}`);
    }

    return {
      facts,
      naming: { title: facts.name, year: facts.year ? String(facts.year) : "" },
      relevance: {
        mediaType: this.download.mediaType,
        name: facts.name,
        year: facts.year,
        overview: facts.overview,
        season: this.download.season,
      },
    };
  }

  /** The Prowlarr query for this title, narrowed to a season or episode. */
  private query(context: DownloadContext, scope: { season?: number; episode?: number }): TitleQuery {
    const type: MediaType = this.download.mediaType;
    return {
      name: context.facts.name,
      year: context.facts.year,
      imdbId: context.facts.imdbId,
      tvdbId: context.facts.tvdbId,
      type,
      ...scope,
    };
  }

  // ---------- Outcomes ---------- //

  /** Records how a download that stopped early ended. */
  private recordFailure(error: unknown): void {
    // Paused by the killswitch: unfinished, so the queue resumes it later
    if (error instanceof SuspendedError) {
      for (const episode of Episode.forDownload(this.download.id)) {
        if (episode.status === "searching" || episode.status === "downloading") episode.setStatus("pending");
      }
      this.download.setStatus("queued", DownloadRunner.pausedMessage(error.message));
      return;
    }

    // Cancelled: episodes caught mid-flight are cancelled with it
    if (error instanceof CancelledError) {
      for (const episode of Episode.forDownload(this.download.id)) {
        if (episode.status === "searching" || episode.status === "downloading") episode.setStatus("cancelled");
      }
      this.download.setStatus("cancelled", "Cancelled");
      return;
    }

    // Environment problems fail the download with their explanation; bugs with a
    // plain one. The technical cause goes to the log, never to the user
    const fatal = error instanceof FatalDownloadError;
    const cause = fatal ? error.cause : error;
    if (cause !== undefined) console.error(`[Download ${this.download.id}] Failed:`, cause);
    const episodes = this.download.mediaType === "tv" ? this.tally(Episode.forDownload(this.download.id)) : undefined;
    this.download.finish("failed", fatal ? error.message : UNEXPECTED_FAILURE, episodes);
  }

  /** Episode numbers grouped by outcome, for the download's result. */
  private tally(episodes: Episode[]): { completed: number[]; failed: number[]; unaired: number[] } {
    const numbers = (status: string) =>
      episodes.filter((episode) => episode.status === status).map((episode) => episode.episodeNumber);
    return { completed: numbers("completed"), failed: numbers("failed"), unaired: numbers("unaired") };
  }

  /** The status message of a download waiting for the VPN. */
  public static pausedMessage(reason: string): string {
    return `Paused until the VPN is back: ${reason}`;
  }

  private unitKey(unit: WorkUnit): string {
    return unit.episode?.id ?? "main";
  }

  private episodeCode(season: number, episode: number): string {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
