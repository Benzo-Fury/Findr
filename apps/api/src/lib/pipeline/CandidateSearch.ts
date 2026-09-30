/**
 * The once-per-unit search step: query Prowlarr, parse every release, score
 * it against the unit's target, screen the best with the relevance filter,
 * and persist the lot as candidates. Rejected releases are stored too, with
 * their reason, so the UI can show why nothing better was tried.
 *
 * A unit is the movie, the season pack, or one episode. The attempt loop only
 * ever walks what this step stored — it never queries indexers itself.
 */

import type { Settings } from "@findr/types/settings";
import { Candidate, type NewCandidate } from "../db/models/Candidate";
import Prowlarr, { ProwlarrError, type ProwlarrRelease, type TitleQuery } from "../prowlarr/Prowlarr";
import { ReleaseParser } from "../releases/ReleaseParser";
import { ReleaseScorer, type ScoreTarget } from "../releases/ReleaseScorer";
import { FatalDownloadError } from "./errors";
import { RelevanceFilter, type RelevanceContext } from "./RelevanceFilter";

// ---------- Types ---------- //

/** Everything needed to search for one unit of work. */
export interface SearchRequest {
  downloadId: string;
  episodeId: string | null;
  query: TitleQuery;
  target: ScoreTarget;
  relevance: RelevanceContext;
  settings: Settings;
}

/** A tally of what the search found, for status messages. */
export interface SearchSummary {
  found: number;
  eligible: number;
}

// ---------- Search ---------- //

export class CandidateSearch {
  private readonly parser = new ReleaseParser();

  /**
   * Runs the search and stores its candidates. Releases already stored for
   * this unit (from an earlier search) are skipped, so re-searching only
   * adds what is new.
   */
  public async run(request: SearchRequest): Promise<SearchSummary> {
    // Query indexers; a dead or unconfigured Prowlarr fails the whole download
    let releases: ProwlarrRelease[];
    try {
      releases = await Prowlarr.getInstance().search(request.query);
    } catch (error) {
      if (error instanceof ProwlarrError) throw new FatalDownloadError(`Indexer search failed: ${error.message}`);
      throw error;
    }

    // Collapse cross-posts and drop anything already stored for this unit
    const known = new Set(Candidate.forDownload(request.downloadId)
      .filter((candidate) => candidate.episodeId === request.episodeId)
      .map((candidate) => this.identity(candidate.source().infoHash, candidate.title, candidate.sizeMB)));
    const fresh = this.dedupe(releases).filter(
      (release) => !known.has(this.identity(release.infoHash, release.title, release.sizeMB)),
    );

    // Parse and score each release against the unit's target
    const scorer = new ReleaseScorer(request.target, request.settings.preferences);
    const evaluated = fresh.map((release) => {
      const parsed = this.parser.parse(release.title);
      const verdict = scorer.evaluate({
        parsed,
        sizeMB: release.sizeMB,
        seeders: release.seeders,
        publishedAt: release.publishedAt,
      });
      return { release, parsed, verdict };
    });

    // Screen the best of the survivors for wrong-title matches
    const eligible = evaluated
      .filter((entry) => entry.verdict.accepted)
      .sort((a, b) => this.scoreOf(b.verdict) - this.scoreOf(a.verdict));
    const drops = await new RelevanceFilter(request.settings.llmFilter).screen(
      request.relevance,
      eligible.map((entry, index) => ({ id: String(index), title: entry.release.title })),
    );
    const dropReasons = new Map(
      eligible.flatMap((entry, index) => {
        const reason = drops.get(String(index));
        return reason ? [[entry, reason] as const] : [];
      }),
    );

    // Persist everything, rejected releases included
    const rows: NewCandidate[] = evaluated.map((entry) => {
      const llmReason = dropReasons.get(entry);
      const rejection = !entry.verdict.accepted ? entry.verdict.reason : llmReason ? `Wrong title: ${llmReason}` : null;
      return {
        downloadId: request.downloadId,
        episodeId: request.episodeId,
        title: entry.release.title,
        indexer: entry.release.indexer,
        infoHash: entry.release.infoHash,
        magnetUri: entry.release.magnetUri,
        downloadUrl: entry.release.downloadUrl,
        sizeMB: entry.release.sizeMB,
        seeders: entry.release.seeders,
        leechers: entry.release.leechers,
        publishedAt: entry.release.publishedAt?.getTime() ?? null,
        parsed: entry.parsed,
        score: entry.verdict.accepted ? entry.verdict.score : null,
        status: rejection ? "rejected" : "pending",
        rejectionReason: rejection,
      };
    });
    Candidate.insertMany(rows);

    return { found: rows.length, eligible: rows.filter((row) => row.status === "pending").length };
  }

  // ---------- Helpers ---------- //

  /**
   * Keeps one copy of each release. The same torrent is often listed by
   * several indexers; the best-seeded listing wins.
   */
  private dedupe(releases: ProwlarrRelease[]): ProwlarrRelease[] {
    const best = new Map<string, ProwlarrRelease>();
    for (const release of releases) {
      const key = this.identity(release.infoHash, release.title, release.sizeMB);
      const existing = best.get(key);
      if (!existing || release.seeders > existing.seeders) best.set(key, release);
    }
    return [...best.values()];
  }

  /** Info hash when known, otherwise normalised title plus size. */
  private identity(infoHash: string | null, title: string, sizeMB: number): string {
    return infoHash ?? `${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${sizeMB}`;
  }

  private scoreOf(verdict: { accepted: true; score: number } | { accepted: false }): number {
    return verdict.accepted ? verdict.score : -Infinity;
  }
}
