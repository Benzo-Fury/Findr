/**
 * Server-side TMDB client. Every TMDB call the web app needs goes through
 * here so the API key never leaves the server and the expensive multi-request
 * endpoints (featured, discover feed) can share a single in-memory cache.
 *
 * Curated lists are not hardcoded here — they come from the catalog in
 * `sources.ts`, which both the list endpoint and the discover feed read from.
 */

import type {
  DiscoverFeed,
  DiscoverRow,
  PosterItem,
  PosterPage,
  TMDBMediaType,
} from "@findr/types";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { env } from "../env/Env";
import {
  FEED_ROWS,
  LIST_SOURCES,
  resolveParams,
  type FeedRow,
  type ListSource,
  type ListSourceKey,
} from "./sources";

/** Shape of the fields Findr reads off a TMDB list entry. */
interface RawItem {
  id: number;
  title?: string;
  name?: string;
  media_type?: string;
  poster_path: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
}

/** Envelope TMDB wraps every paginated list in. */
interface RawPage {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: RawItem[];
}

/** Options accepted when reading a list from the catalog. */
interface ListOptions {
  page?: number;
  /** Only meaningful for sources defined over both movie and TV paths. */
  mediaType?: TMDBMediaType | "all";
}

/** Controls how raw TMDB entries are narrowed into poster items. */
interface MapOptions {
  mediaType?: TMDBMediaType;
  /** Drops entries with no artwork — right for grids, wrong for search. */
  requirePoster?: boolean;
}

const BASE_URL = "https://api.themoviedb.org/3";

/** How long the featured and discover-feed payloads stay warm. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** TMDB refuses pages beyond 500. */
const MAX_PAGE = 500;

/** Raised when TMDB is unreachable or answers with a non-2xx status. */
export class TMDBError extends Error {}

/* ------------------------------------------------------------------------ */
/* Client                                                                     */
/* ------------------------------------------------------------------------ */

export default class TMDB extends SelfManagedSingleton {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  /* ---------------------------------------------------------------------- */
  /* Lists                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Reads one of the catalog's named lists as a page of poster items.
   *
   * Sources defined over both a movie and a TV path accept a media type. The
   * `"all"` case fetches the same page number from each and re-sorts the
   * merged results by rating — TMDB has no combined endpoint, so ordering is
   * correct within the page but not across page boundaries.
   */
  public async list(key: ListSourceKey, options: ListOptions = {}): Promise<PosterPage> {
    const source: ListSource = LIST_SOURCES[key];
    const page = this.clampPage(options.page ?? 1);
    const params = { ...resolveParams(source), page: String(page) };

    // Single-path sources ignore the media type entirely.
    if (typeof source.path === "string") {
      const data = await this.request<RawPage>(source.path, params);

      return {
        page: data.page ?? page,
        total_pages: data.total_pages ?? 1,
        total_results: data.total_results ?? 0,
        results: this.toPosterItems(data.results, { mediaType: source.mediaType }),
      };
    }

    const wanted: TMDBMediaType[] =
      !options.mediaType || options.mediaType === "all"
        ? ["movie", "tv"]
        : [options.mediaType];

    const pages = await Promise.all(
      wanted.map(async (mediaType) => ({
        mediaType,
        data: await this.request<RawPage>(
          (source.path as Record<TMDBMediaType, string>)[mediaType],
          params,
        ),
      })),
    );

    const results = pages
      .flatMap(({ mediaType, data }) => this.toPosterItems(data.results, { mediaType }))
      .sort((a, b) => b.vote_average - a.vote_average);

    return {
      page,
      total_pages: Math.max(...pages.map(({ data }) => data.total_pages ?? 1)),
      total_results: pages.reduce((sum, { data }) => sum + (data.total_results ?? 0), 0),
      results,
    };
  }

  /**
   * Trending posters for the unauthenticated login backdrop. Cached so a
   * burst of visitors costs at most one TMDB call per TTL window.
   */
  public async featured(): Promise<PosterItem[]> {
    return this.cached("featured", async () => {
      const { results } = await this.list("trending");
      return results;
    });
  }

  /**
   * The full discover page — every catalog row fetched in parallel and cached
   * as one payload. Rows that fail or come back empty are dropped rather than
   * failing the whole feed.
   */
  public async discoverFeed(): Promise<DiscoverFeed> {
    return this.cached("discover-feed", async () => {
      const rows = await Promise.all(FEED_ROWS.map((row) => this.fetchRow(row)));

      return { rows: rows.filter((row): row is DiscoverRow => row !== null) };
    });
  }

  /** Loads a single discover row, returning null when it has nothing to show. */
  private async fetchRow(row: FeedRow): Promise<DiscoverRow | null> {
    try {
      const { results } = await this.list(row.source, { mediaType: row.mediaType });
      const items = row.limit ? results.slice(0, row.limit) : results;

      if (items.length === 0) return null;

      return {
        id: row.mediaType ? `${row.source}-${row.mediaType}` : row.source,
        title: row.title ?? LIST_SOURCES[row.source].title,
        items,
      };
    } catch (error) {
      console.error(`[TMDB] Discover row "${row.source}" failed:`, error);
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Lookups                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Multi-search across movies and shows. Results keep their artwork field
   * even when empty, since a title with no poster is still a valid thing to
   * pick out of the search dialog.
   */
  public async search(query: string): Promise<PosterPage> {
    const data = await this.request<RawPage>("/search/multi", {
      query,
      page: "1",
      include_adult: "false",
    });

    return {
      page: data.page ?? 1,
      total_pages: data.total_pages ?? 1,
      total_results: data.total_results ?? 0,
      results: this.toPosterItems(data.results, { requirePoster: false }),
    };
  }

  /**
   * Full details for a title, with the extras the detail dialog renders
   * appended in the same round trip.
   */
  public async details(mediaType: TMDBMediaType, id: number): Promise<unknown> {
    const extras = ["videos", "recommendations", "credits", "external_ids"];
    if (mediaType === "movie") extras.push("release_dates");

    return this.request(`/${mediaType}/${id}`, {
      append_to_response: extras.join(","),
    });
  }

  /** Resolves an IMDb ID to its TMDB records. Passed through untouched. */
  public async find(imdbId: string): Promise<unknown> {
    return this.request(`/find/${imdbId}`, { external_source: "imdb_id" });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                                */
  /* ---------------------------------------------------------------------- */

  /** Performs a GET against TMDB with the API key applied. */
  private async request<T = unknown>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const key = env.TMDB_API_KEY;
    if (!key) throw new TMDBError("TMDB_API_KEY is not configured");

    const url = new URL(`${BASE_URL}${path}`);
    url.search = new URLSearchParams({ ...params, api_key: key }).toString();

    const res = await fetch(url).catch((error) => {
      throw new TMDBError(`TMDB request failed: ${error}`);
    });

    if (!res.ok) {
      throw new TMDBError(`TMDB responded with ${res.status} for ${path}`);
    }

    return res.json() as Promise<T>;
  }

  /** Returns the cached value for a key, loading and storing it when stale. */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;

    const value = await load();
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  /** Maps TMDB list entries to poster items, dropping anything unrenderable. */
  private toPosterItems(items: RawItem[] = [], options: MapOptions = {}): PosterItem[] {
    const { mediaType, requirePoster = true } = options;

    return items.reduce<PosterItem[]>((acc, raw) => {
      const type = mediaType ?? (raw.media_type as TMDBMediaType | undefined);
      if (type !== "movie" && type !== "tv") return acc;

      const title = type === "movie" ? raw.title : raw.name;
      if (!title) return acc;
      if (requirePoster && !raw.poster_path) return acc;

      const date = type === "movie" ? raw.release_date : raw.first_air_date;

      acc.push({
        id: raw.id,
        media_type: type,
        title,
        poster_path: raw.poster_path,
        vote_average: raw.vote_average ?? 0,
        ...(date ? { year: date.slice(0, 4) } : {}),
      });

      return acc;
    }, []);
  }

  /** Keeps a requested page inside the range TMDB will serve. */
  private clampPage(page: number): number {
    if (!Number.isFinite(page)) return 1;
    return Math.min(Math.max(Math.trunc(page), 1), MAX_PAGE);
  }
}
