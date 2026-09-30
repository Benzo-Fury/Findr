/**
 * Turns a raw release title, exactly as an indexer published it, into the
 * structured fields scoring and the download planner work from.
 *
 * Titles are free text with loose conventions, so every field is best effort
 * and nullable. The one thing that must be reliable is `kind`: a series job
 * only accepts complete season packs or single episodes, and telling
 * `S02` apart from `S02E01`, `S02E01-E03` or `S01-S05` is what decides which
 * releases are even eligible.
 */

import type {
  AudioCodec,
  HDRFormat,
  ReleaseType,
  Resolution,
  VideoCodec,
} from "@findr/types/media";
import type { ParsedRelease, ReleaseKind } from "@findr/types/release";

// ---------- Pattern tables ---------- //

/** A pattern and the value it identifies. Tables are checked in order; the first hit wins. */
type PatternTable<T> = ReadonlyArray<readonly [RegExp, T]>;

const RESOLUTION: PatternTable<Resolution> = [
  [/\b(2160p|4K|UHD)\b/i, "2160p"],
  [/\b1080[pi]\b/i, "1080p"],
  [/\b720p\b/i, "720p"],
  [/\b(480[pi]|576[pi])\b/i, "480p"],
];

const VIDEO_CODEC: PatternTable<VideoCodec> = [
  [/\b([xh] ?265|HEVC)\b/i, "x265"],
  [/\b([xh] ?264|AVC)\b/i, "x264"],
  [/\bAV1\b/i, "AV1"],
];

/** Atmos and TrueHD come first because they share titles with the codecs that carry them. */
const AUDIO_CODEC: PatternTable<AudioCodec> = [
  [/\bAtmos\b/i, "DolbyAtmos"],
  [/\bTrueHD\b/i, "TrueHD"],
  [/\bDTS/i, "DTS"],
  [/\b(E-?AC-?3|DDP|DD\+)/i, "EAC3"],
  [/\bFLAC\b/i, "FLAC"],
  [/\bAAC/i, "AAC"],
];

const HDR: PatternTable<HDRFormat> = [
  [/\b(DolbyVision|Dolby Vision|DoVi|DV)\b/i, "DolbyVision"],
  [/\b(HDR10\+?|HDR)\b/i, "HDR10"],
];

/** Remux before BluRay, since remuxes usually say both. Bare `WEB` is treated as WEB-DL. */
const RELEASE_TYPE: PatternTable<ReleaseType> = [
  [/\b(Remux|BDRemux)\b/i, "Remux"],
  [/\bBlu-?Ray\b/i, "BluRay"],
  [/\bWEB-?DL\b/i, "WEB-DL"],
  [/\bWEB-?Rip\b/i, "WEBRip"],
  [/\bWEB\b/i, "WEB-DL"],
  [/\bHDTV\b/i, "HDTV"],
  [/\bHDRip\b/i, "HDRip"],
  [/\b(BDRip|BRRip)\b/i, "BDRip"],
  [/\bDVDRip\b/i, "DVDRip"],
  [/\b(CAMRip|HDCAM|CAM)\b/i, "CAM"],
  [/\b(TELESYNC|TELECINE|HDTS|HD-TS|TS|TC|R5|R6)\b/i, "TS"],
  [/\b(SCR|SCREENER|DVDSCR)\b/i, "SCR"],
];

/** Streaming service tags imply a web release even when the source tag is missing. */
const STREAMING_SERVICE = /\b(AMZN|NF|NETFLIX|DSNP|HMAX|MAX|ATVP|PMTP|PCOK|CRAV|HULU|iT)\b/;

const REPACK = /\b(PROPER|REPACK|RERIP)\b/i;

/** Well-known groups that tag releases in brackets rather than with a `-GROUP` suffix. */
const BRACKET_GROUPS: PatternTable<string> = [
  [/\[(YTS|YIFY)[^\]]*\]/i, "YTS"],
  [/\[(EZTV)[^\]]*\]/i, "EZTV"],
];

/** Media and container extensions some indexers leave on the end of a title. */
const FILE_EXTENSION = /\.(mkv|mp4|avi|m4v|ts|wmv)$/i;

// ---------- Season and episode patterns ---------- //

/** `S01E02`, `S1E2`, `S01 E02`. Captures season and the first episode. */
const SEASON_EPISODE = /\bS(\d{1,2}) ?E(\d{1,3})/i;

/** `1x05`, `22x01`. Only trusted when not part of a resolution like `1920x1080`. */
const CROSS_EPISODE = /\b(\d{1,2})x(\d{2,3})\b/i;

/** Continuations after the first episode: `E03`, `-E03`, `-03`, `-S01E03`. */
const EPISODE_LIST_ITEM = /^ ?E(\d{1,3})/i;
const EPISODE_RANGE_END = /^ ?- ?(?:S\d{1,2} ?)?E?(\d{1,3})\b/i;

/** `S01-S05`, `S01-05`, `S1 - S5`, `S01-S05` spelled as `Seasons 1-5` or `Season 1-5`. */
const SEASON_RANGE = /\b(?:S(\d{1,2}) ?- ?S?(\d{1,2})|Seasons? (\d{1,2}) ?(?:-|to) ?(\d{1,2}))\b/i;

/** `S02` alone, `Season 2`, `Season 02`. The negative lookahead rejects `S02E01`. */
const SINGLE_SEASON = /\b(?:S(\d{1,2})(?! ?E\d)|Season (\d{1,2}))\b/i;

/** Consecutive season tags such as `S01 S02 S03`. */
const SEASON_TAG = /\bS(\d{1,2})\b(?! ?E\d)/gi;

const COMPLETE_SERIES = /\b(complete series|the complete|complete collection|all seasons)\b/i;

/** Plausible release years: 1900 up to next year. */
const YEAR = /\b(19\d{2}|20\d{2})\b/g;

// ---------- Parser ---------- //

/**
 * Stateless release title parser. Instances hold no state; the class exists to
 * group the parsing steps behind one entry point.
 */
export class ReleaseParser {
  /** Parses a raw title into every field Findr understands. */
  public parse(rawTitle: string): ParsedRelease {
    // Normalise separators so patterns only need to handle spaces
    const withoutExtension = rawTitle.trim().replace(FILE_EXTENSION, "");
    const text = withoutExtension.replace(/[._]+/g, " ").replace(/\s+/g, " ");

    // Quality tags sit after the title, so only look for them there. This
    // keeps a movie called "Cam" or a show called "TS" from being misread.
    const tags = text.slice(this.tagRegionStart(text));

    // Structure decides eligibility, so it is parsed from the full text
    const { kind, seasons, episodes } = this.structure(text);

    return {
      kind,
      seasons,
      episodes,
      resolution: this.firstMatch(tags, RESOLUTION),
      videoCodec: this.firstMatch(tags, VIDEO_CODEC),
      audioCodec: this.firstMatch(tags, AUDIO_CODEC),
      hdrFormat: this.firstMatch(tags, HDR),
      releaseType: this.releaseType(tags),
      group: this.group(withoutExtension),
      year: this.year(text),
      isRepack: REPACK.test(tags),
    };
  }

  // ---------- Structure ---------- //

  /**
   * Classifies what the release covers. Checked from most to least specific:
   * explicit episodes, then season ranges, then a lone season, then an
   * unnumbered "complete series", falling back to a movie.
   */
  private structure(text: string): { kind: ReleaseKind; seasons: number[]; episodes: number[] } {
    // Specific episodes, in either S01E02 or 1x02 form
    const episodeMatch = this.episodeMarkers(text);
    if (episodeMatch) {
      return { kind: "episode", seasons: [episodeMatch.season], episodes: episodeMatch.episodes };
    }

    // A span of seasons such as S01-S05 or "Seasons 1-5"
    const range = text.match(SEASON_RANGE);
    if (range) {
      const from = Number(range[1] ?? range[3]);
      const to = Number(range[2] ?? range[4]);
      if (to > from) return { kind: "multi-season", seasons: this.span(from, to), episodes: [] };
    }

    // Several separate season tags, e.g. "S01 S02"
    const tagged = [...new Set([...text.matchAll(SEASON_TAG)].map((match) => Number(match[1])))];
    if (tagged.length > 1) {
      return { kind: "multi-season", seasons: tagged.sort((a, b) => a - b), episodes: [] };
    }

    // One season with no episode markers — a season pack
    const single = text.match(SINGLE_SEASON);
    if (single) {
      return { kind: "season", seasons: [Number(single[1] ?? single[2])], episodes: [] };
    }

    // The whole show, advertised without season numbers
    if (COMPLETE_SERIES.test(text)) return { kind: "complete-series", seasons: [], episodes: [] };

    return { kind: "movie", seasons: [], episodes: [] };
  }

  /**
   * Finds explicit episode markers and expands any list or range that follows
   * the first one: `S01E01E02`, `S01E01-E03`, `S01E01-03` and `S01E01-S01E03`
   * all yield every episode they cover.
   */
  private episodeMarkers(text: string): { season: number; episodes: number[] } | null {
    // Prefer the SxxEyy form; fall back to 1x02 when it is not a resolution
    const primary = text.match(SEASON_EPISODE);
    const cross = primary ? null : text.match(CROSS_EPISODE);
    const match = primary ?? cross;
    if (!match || match.index === undefined) return null;

    const season = Number(match[1]);
    const first = Number(match[2]);
    const episodes = [first];

    // Walk what follows the first marker, collecting list items and range ends
    let rest = text.slice(match.index + match[0].length);
    while (rest.length > 0) {
      const listItem = rest.match(EPISODE_LIST_ITEM);
      if (listItem) {
        episodes.push(Number(listItem[1]));
        rest = rest.slice(listItem[0].length);
        continue;
      }

      const rangeEnd = rest.match(EPISODE_RANGE_END);
      const last = episodes.at(-1) ?? first;
      if (rangeEnd && Number(rangeEnd[1]) > last) {
        episodes.push(...this.span(last + 1, Number(rangeEnd[1])));
        rest = rest.slice(rangeEnd[0].length);
        continue;
      }

      break;
    }

    return { season, episodes: [...new Set(episodes)].sort((a, b) => a - b) };
  }

  // ---------- Fields ---------- //

  /**
   * Where the quality tags begin: the first year, season marker or resolution.
   * Everything before that is the title itself.
   */
  private tagRegionStart(text: string): number {
    const markers = [/\b(19|20)\d{2}\b/, /\bS\d{1,2}/i, /\bSeasons? \d/i, /\b\d{3,4}[pi]\b/i, /\b\d{1,2}x\d{2,3}\b/];
    const positions = markers
      .map((pattern) => text.search(pattern))
      .filter((index) => index > 0);

    return positions.length > 0 ? Math.min(...positions) : 0;
  }

  /** The source tag, or WEB-DL when only a streaming service is named. */
  private releaseType(tags: string): ReleaseType | null {
    return this.firstMatch(tags, RELEASE_TYPE) ?? (STREAMING_SERVICE.test(tags) ? "WEB-DL" : null);
  }

  /**
   * The release group: the `-GROUP` suffix, ignoring trailing bracketed site
   * tags like `[TGx]` or `[rarbg]`. Falls back to known bracket-style groups
   * such as `[YTS.MX]`.
   */
  private group(title: string): string | null {
    // Strip trailing site tags before looking for the suffix
    const trimmed = title.replace(/(\s*\[[^\]]*\])+\s*$/, "");
    const suffix = trimmed.match(/-([A-Za-z0-9]+)$/);
    if (suffix?.[1] && !/^\d+$/.test(suffix[1])) return suffix[1];

    return this.firstMatch(title, BRACKET_GROUPS);
  }

  /**
   * The release year. Titles can contain years of their own ("Blade Runner
   * 2049", "1917"), so the last plausible year wins — the release year follows
   * the title.
   */
  private year(text: string): number | null {
    const latestPlausible = new Date().getFullYear() + 1;
    const years = [...text.matchAll(YEAR)]
      .map((match) => Number(match[1]))
      .filter((year) => year <= latestPlausible);

    return years.at(-1) ?? null;
  }

  // ---------- Helpers ---------- //

  /** Returns the value of the first pattern that matches, or null. */
  private firstMatch<T>(text: string, table: PatternTable<T>): T | null {
    for (const [pattern, value] of table) {
      if (pattern.test(text)) return value;
    }
    return null;
  }

  /** Inclusive integer range. */
  private span(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
  }
}
