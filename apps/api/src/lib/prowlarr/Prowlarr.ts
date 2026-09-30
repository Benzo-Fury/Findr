/**
 * Thin client over Prowlarr's `/api/v1/search` endpoint — the only Prowlarr
 * functionality Findr uses. Callers hand over the title fields they already
 * have (name, year, IMDb id, season) and get back a ranked list of torrents;
 * building Prowlarr's search DSL, picking categories, and normalising the
 * `ReleaseResource` payload all happen in here.
 *
 * Prowlarr federates whatever indexers its instance has configured, so a
 * search that returns few results usually means indexers are misconfigured or
 * timing out rather than that no release exists — Prowlarr reports per-indexer
 * failures as a short array, not an error status.
 */

import { env } from "../env/Env";
import SelfManagedSingleton from "../other/SelfManagedSingleton";

/* ------------------------------------------------------------------------ */
/* Types                                                                      */
/* ------------------------------------------------------------------------ */

/** The title fields a search is built from. */
export interface TitleQuery {
  name: string;
  year: number;
  /** Season number, for series only. Omit to search the whole show. */
  season?: number;
  imdbId: string;
  type: "movie" | "series";
}

/** A single torrent release returned from Prowlarr. */
export interface Torrent {
  /** Release title exactly as the indexer published it. */
  title: string;
  /**
   * Magnet URI when the indexer exposes one, otherwise a Prowlarr-proxied
   * `.torrent` URL carrying the API key. Both are accepted by WebTorrent.
   */
  downloadLink: string;
  /** BitTorrent info hash, when the indexer reports it. */
  infoHash?: string;
  sizeMB: number;
  seeders: number;
  leechers: number;
  /** Name of the indexer that served this release. */
  indexer: string;
  publishedAt?: Date;
}

/** Options narrowing how many results come back. */
export interface SearchOptions {
  /** Maximum releases to request from Prowlarr. Defaults to 100. */
  limit?: number;
  /** Restrict the search to specific indexer ids. Defaults to all enabled. */
  indexerIds?: number[];
}

/** Subset of Prowlarr's `ReleaseResource` that Findr reads. */
interface ReleaseResource {
  title?: string | null;
  size?: number;
  seeders?: number | null;
  leechers?: number | null;
  magnetUrl?: string | null;
  infoHash?: string | null;
  downloadUrl?: string | null;
  publishDate?: string;
  indexer?: string | null;
  protocol?: string;
}

/** Raised when Prowlarr is unconfigured, unreachable, or answers non-2xx. */
export class ProwlarrError extends Error {}

/** Newznab category roots — 2000 is movies, 5000 is TV. */
const CATEGORIES: Record<TitleQuery["type"], number> = {
  movie: 2000,
  series: 5000,
};

/** Prowlarr's search modes, keyed by the media type being searched. */
const SEARCH_TYPES: Record<TitleQuery["type"], string> = {
  movie: "movie",
  series: "tvsearch",
};

const DEFAULT_LIMIT = 100;

const TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------------ */
/* Client                                                                     */
/* ------------------------------------------------------------------------ */

export default class Prowlarr extends SelfManagedSingleton {
  /**
   * Searches every configured indexer for a title and returns the usable
   * torrent releases, sorted by seeders.
   *
   * An id-based search runs first; if it comes back empty — common on
   * indexers that ignore IMDb ids, and on season searches, which many
   * indexers refuse to combine with an id — it falls back to a plain text
   * search over the name and year.
   */
  public async search(title: TitleQuery, options: SearchOptions = {}): Promise<Torrent[]> {
    // Try the precise id-based query, then widen to text if nothing landed
    let releases = await this.request(this.idQuery(title), title, options);
    if (releases.length === 0) {
      releases = await this.request(this.textQuery(title), title, options);
    }

    // Drop usenet and linkless entries, then rank by swarm health
    return releases
      .filter((release) => release.protocol !== "usenet" && this.downloadLink(release))
      .map((release) => this.toTorrent(release))
      .sort((a, b) => b.seeders - a.seeders);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Builds the id-based query in Prowlarr's search DSL. Season is appended
   * for series so indexers that support it return season packs directly.
   */
  private idQuery(title: TitleQuery): string {
    const id = `{ImdbId:${title.imdbId}}`;

    return title.season === undefined ? id : `${id} {Season:${title.season}}`;
  }

  /** Builds the plain text fallback: name plus year, or name plus season. */
  private textQuery(title: TitleQuery): string {
    if (title.season !== undefined) return `${title.name} {Season:${title.season}}`;

    return `${title.name} ${title.year}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                                */
  /* ---------------------------------------------------------------------- */

  /** Performs a search against Prowlarr with the API key applied. */
  private async request(
    query: string,
    title: TitleQuery,
    options: SearchOptions,
  ): Promise<ReleaseResource[]> {
    const { baseUrl, apiKey } = this.credentials();

    // Assemble the query string; categories repeat rather than comma-join
    const url = new URL("/api/v1/search", baseUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("type", SEARCH_TYPES[title.type]);
    url.searchParams.set("limit", String(options.limit ?? DEFAULT_LIMIT));
    url.searchParams.append("categories", String(CATEGORIES[title.type]));
    for (const id of options.indexerIds ?? []) {
      url.searchParams.append("indexerIds", String(id));
    }

    const res = await fetch(url, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error) => {
      throw new ProwlarrError(`Prowlarr request failed: ${error}`);
    });

    if (!res.ok) {
      throw new ProwlarrError(`Prowlarr responded with ${res.status} for "${query}"`);
    }

    return res.json() as Promise<ReleaseResource[]>;
  }

  /** Reads and validates the Prowlarr connection details from the env. */
  private credentials(): { baseUrl: string; apiKey: string } {
    const baseUrl = env.PROWLARR_URL;
    const apiKey = env.PROWLARR_API_KEY;

    if (!baseUrl) throw new ProwlarrError("PROWLARR_URL is not configured");
    if (!apiKey) throw new ProwlarrError("PROWLARR_API_KEY is not configured");

    return { baseUrl, apiKey };
  }

  /**
   * Resolves the best link for a release. Private indexers frequently omit
   * `magnetUrl`, so an info hash is promoted to a magnet before falling back
   * to Prowlarr's `.torrent` proxy.
   */
  private downloadLink(release: ReleaseResource): string | undefined {
    if (release.magnetUrl) return release.magnetUrl;
    if (release.infoHash) return `magnet:?xt=urn:btih:${release.infoHash}`;

    return release.downloadUrl ?? undefined;
  }

  /** Narrows a Prowlarr release into the shape Findr works with. */
  private toTorrent(release: ReleaseResource): Torrent {
    return {
      title: release.title ?? "",
      downloadLink: this.downloadLink(release)!,
      infoHash: release.infoHash ?? undefined,
      sizeMB: Math.round((release.size ?? 0) / 1_048_576),
      seeders: release.seeders ?? 0,
      leechers: release.leechers ?? 0,
      indexer: release.indexer ?? "unknown",
      publishedAt: release.publishDate ? new Date(release.publishDate) : undefined,
    };
  }
}
