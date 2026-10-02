/**
 * Decides whether a parsed release is eligible for a download and, if it is,
 * how good it is. Hard filters run first and reject outright with a reason;
 * only releases that survive them get a weighted score.
 *
 * The rank tables live in `@findr/config/scoring`. Everything the user tunes
 * arrives from the settings store: their limits (resolutions, size ceiling,
 * seeders, blacklist) as `Preferences`, and how much each signal counts as
 * `ScoringSettings`.
 */

import { codecRank, defaultResolutionRank, releaseTypeRank, reputableGroups } from "@findr/config/scoring";
import type { ParsedRelease } from "@findr/types/release";
import type { Preferences, ScoringSettings } from "@findr/types/settings";

// ---------- Types ---------- //

/**
 * What the download is looking for. Structure checks are strict: a season
 * target only accepts a pack of exactly that season, and an episode target
 * only accepts a release of exactly that one episode.
 */
export type ScoreTarget =
  | { kind: "movie"; year: number | null }
  | { kind: "season"; season: number; episodeCount: number }
  | { kind: "episode"; season: number; episode: number };

/** The release fields the scorer reads alongside the parsed title. */
export interface ScorableRelease {
  parsed: ParsedRelease;
  sizeMB: number;
  seeders: number;
  publishedAt: Date | null;
}

/** Either a score, or the reason the release can never be used for this target. */
export type ScoreResult =
  | { accepted: true; score: number }
  | { accepted: false; reason: string };

/** Movies whose parsed year is further than this from the requested year are rejected. */
const YEAR_TOLERANCE = 1;

// ---------- Scorer ---------- //

/** Scores releases for one target under one set of preferences and weights. */
export class ReleaseScorer {
  /** Captures the target, preferences and weights every evaluation in this batch shares. */
  constructor(
    private readonly target: ScoreTarget,
    private readonly preferences: Preferences,
    private readonly weights: ScoringSettings,
    private readonly now: Date = new Date(),
  ) {}

  /** Runs the hard filters, then scores whatever survives them. */
  public evaluate(release: ScorableRelease): ScoreResult {
    const reason = this.rejectionReason(release);
    if (reason) return { accepted: false, reason };

    return { accepted: true, score: this.score(release) };
  }

  // ---------- Hard filters ---------- //

  /** The first hard filter the release fails, or null when it passes them all. */
  private rejectionReason(release: ScorableRelease): string | null {
    const { parsed } = release;

    // Wrong shape for what was asked for
    const structure = this.structureMismatch(parsed);
    if (structure) return structure;

    // User blacklist, typically CAM and telesync rips
    if (parsed.releaseType && this.preferences.blacklistedReleaseTypes.includes(parsed.releaseType)) {
      return `Blacklisted release type ${parsed.releaseType}`;
    }

    // Too few seeders to finish in reasonable time
    if (release.seeders < this.preferences.minSeeders) {
      return `Only ${release.seeders} seeder(s), minimum is ${this.preferences.minSeeders}`;
    }

    // Size ceiling, scaled for season packs
    const perUnitGB = this.perUnitGB(release.sizeMB);
    if (perUnitGB > this.preferences.maxFileSizeGB) {
      return `${perUnitGB.toFixed(1)} GB per ${this.unitName()} exceeds the ${this.preferences.maxFileSizeGB} GB limit`;
    }

    // A movie of the same name from a different year is a different movie
    if (this.target.kind === "movie" && this.target.year && parsed.year) {
      if (Math.abs(parsed.year - this.target.year) > YEAR_TOLERANCE) {
        return `Release year ${parsed.year} does not match ${this.target.year}`;
      }
    }

    return null;
  }

  /** Explains why the release's structure cannot satisfy the target, if it cannot. */
  private structureMismatch(parsed: ParsedRelease): string | null {
    switch (this.target.kind) {
      // Movies must carry no season or episode markers
      case "movie":
        return parsed.kind === "movie" ? null : `Looks like a TV release (${parsed.kind})`;

      // Season targets take exactly one whole season, and the right one
      case "season": {
        if (parsed.kind !== "season") return `Not a single-season pack (${parsed.kind})`;
        const [season] = parsed.seasons;
        return season === this.target.season ? null : `Season ${season} pack, wanted season ${this.target.season}`;
      }

      // Episode targets take exactly the one requested episode
      case "episode": {
        if (parsed.kind !== "episode") return `Not a single-episode release (${parsed.kind})`;
        const [season] = parsed.seasons;
        if (season !== this.target.season) return `Season ${season}, wanted season ${this.target.season}`;
        if (parsed.episodes.length !== 1) return `Multi-episode release (E${parsed.episodes.join("-E")})`;
        return parsed.episodes[0] === this.target.episode
          ? null
          : `Episode ${parsed.episodes[0]}, wanted episode ${this.target.episode}`;
      }
    }
  }

  // ---------- Scoring ---------- //

  /** Sums every weighted component into one comparable number. */
  private score(release: ScorableRelease): number {
    const { parsed } = release;

    // Add up each independent quality signal
    let total =
      this.resolutionScore(parsed) +
      this.codecScore(parsed) +
      this.seederScore(release.seeders) +
      this.releaseTypeScore(parsed) +
      this.sizeScore(release.sizeMB) +
      this.groupScore(parsed) +
      this.ageScore(release.publishedAt) +
      (parsed.isRepack ? this.weights.repack : 0);

    // Penalise 4K encodes too large for limited storage
    if (parsed.resolution === "2160p" && this.perUnitGB(release.sizeMB) > this.weights.bloated4KSizeGB) {
      total -= this.weights.bloated4KPenalty;
    }

    return Math.round(total * 100) / 100;
  }

  /**
   * Scores by position in the user's resolution list, so their first choice
   * earns the full weight. Resolutions they did not list earn nothing.
   */
  private resolutionScore(parsed: ParsedRelease): number {
    if (!parsed.resolution) return 0;

    const { resolutions } = this.preferences;
    if (resolutions.length > 0) {
      const index = resolutions.indexOf(parsed.resolution);
      if (index === -1) return 0;
      return ((resolutions.length - index) / resolutions.length) * this.weights.resolution;
    }

    return ((defaultResolutionRank[parsed.resolution] ?? 0) / 3) * this.weights.resolution;
  }

  /** Prefers modern, space-efficient codecs. */
  private codecScore(parsed: ParsedRelease): number {
    if (!parsed.videoCodec) return 0;
    return ((codecRank[parsed.videoCodec] ?? 0) / 3) * this.weights.codec;
  }

  /** Logarithmic in seeders, so the gap between 5 and 50 matters more than 500 and 1000. */
  private seederScore(seeders: number): number {
    const { seederCap } = this.weights;
    const capped = Math.min(seeders, seederCap);
    return (Math.log10(capped + 1) / Math.log10(seederCap + 1)) * this.weights.seeders;
  }

  /** Prefers clean web and Blu-ray sources over rips. */
  private releaseTypeScore(parsed: ParsedRelease): number {
    if (!parsed.releaseType) return 0;
    return ((releaseTypeRank[parsed.releaseType] ?? 0) / 7) * this.weights.releaseType;
  }

  /**
   * A bell curve around the ideal size per movie or episode. Suspiciously
   * tiny files and huge ones are actively penalised rather than just scoring
   * low.
   */
  private sizeScore(sizeMB: number): number {
    if (sizeMB <= 0) return 0;

    // Compare per movie or per episode so packs are judged like single files
    const gb = this.perUnitGB(sizeMB);
    const ideal = this.target.kind === "movie" ? this.weights.idealMovieSizeGB : this.weights.idealEpisodeSizeGB;

    // Hard penalties at the extremes
    if (gb < ideal * 0.125) return -this.weights.fileSize * 0.8;
    if (gb > ideal * 7.5) return -this.weights.fileSize * 0.6;
    if (gb > ideal * 3.75) return -this.weights.fileSize * 0.3;

    // Gaussian falloff either side of the ideal
    const deviation = (gb - ideal) / ideal;
    return Math.exp(-0.5 * deviation * deviation) * this.weights.fileSize;
  }

  /** Full weight for known-good groups, a little for any named group. */
  private groupScore(parsed: ParsedRelease): number {
    if (!parsed.group) return 0;
    if (reputableGroups.has(parsed.group.toUpperCase())) return this.weights.releaseGroup;
    return this.weights.releaseGroup * 0.3;
  }

  /** Newer uploads get a small edge, fading to nothing over a year. */
  private ageScore(publishedAt: Date | null): number {
    if (!publishedAt) return 0;
    const ageDays = (this.now.getTime() - publishedAt.getTime()) / 86_400_000;
    return Math.max(0, 1 - ageDays / 365) * this.weights.uploadDate;
  }

  // ---------- Helpers ---------- //

  /** Size in GB per movie or per episode — packs are divided across their episodes. */
  private perUnitGB(sizeMB: number): number {
    const units = this.target.kind === "season" ? Math.max(this.target.episodeCount, 1) : 1;
    return sizeMB / 1024 / units;
  }

  /** How limits are phrased in rejection reasons. */
  private unitName(): string {
    return this.target.kind === "movie" ? "movie" : "episode";
  }
}
