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
import type { BrowseQuery, BrowseSort, GenreEntry, TitleCard } from "@findr/types/tmdb";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { SettingsStore } from "../db/models/SettingsStore";
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
  backdrop_path?: string | null;
  genre_ids?: number[];
  overview?: string;
}

/** Envelope TMDB wraps every paginated list in. */
interface RawPage {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: RawItem[];
}

/** The fields of TMDB's movie and TV detail payloads the download pipeline reads. */
interface RawTitleDetails {
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
}

/** The fields of TMDB's movie and TV detail payloads a title card reads. */
interface RawCardDetails {
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: Array<{ name: string }>;
  vote_average?: number;
  number_of_seasons?: number;
}

/** TMDB's genre list for one media kind. */
interface RawGenreList {
  genres?: Array<{ id: number; name: string }>;
}

/** The fields of TMDB's season payload the download pipeline reads. */
interface RawSeason {
  episodes?: Array<{ episode_number: number; air_date: string | null }>;
}

/** What the download pipeline needs to know about a title to search for and name it. */
export interface TitleFacts {
  name: string;
  /** Null when TMDB has no release or first-air date. */
  year: number | null;
  overview: string;
  imdbId: string | null;
  tvdbId: number | null;
}

/** One episode of a season, with its air date when TMDB knows it. */
export interface SeasonEpisode {
  number: number;
  /** `YYYY-MM-DD`, or null when unannounced. */
  airDate: string | null;
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
  /**
   * Drops titles that have not come out yet, or have no date at all. Curated
   * lists and genre browsing hide them since there is nothing to download;
   * search keeps them so a title can still be looked up by name.
   */
  releasedOnly?: boolean;
}

const BASE_URL = "https://api.themoviedb.org/3";

/** Longest a single TMDB request may take, so a lookup can never hang a download. */
const REQUEST_TIMEOUT_MS = 20_000;

/** How long the featured and discover-feed payloads stay warm. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** How long title cards and genre lists stay warm; both change rarely. */
const LONG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Detail requests in flight at once while resolving a batch of title cards. */
const CARD_CONCURRENCY = 8;

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
        results: this.toPosterItems(data.results, { mediaType: source.mediaType, releasedOnly: true }),
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
      .flatMap(({ mediaType, data }) => this.toPosterItems(data.results, { mediaType, releasedOnly: true }))
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

  /**
   * One page of titles in a genre, for the discover page's genre view.
   *
   * With `type=all`, each media kind that has a genre id (or both, when no
   * genre is given) is fetched for the same page and the two rankings are
   * interleaved, so neither kind crowds the other out of the page.
   */
  public async browse(query: BrowseQuery): Promise<PosterPage> {
    const page = this.clampPage(query.page);
    const genreFor: Record<TMDBMediaType, number | undefined> = {
      movie: query.movieGenre,
      tv: query.tvGenre,
    };
    const anyGenre = query.movieGenre !== undefined || query.tvGenre !== undefined;

    // A kind is skipped under "all" when the genre only exists on the other side
    const wanted = (query.type === "all" ? (["movie", "tv"] as const) : [query.type]).filter(
      (mediaType) => !anyGenre || genreFor[mediaType] !== undefined,
    );

    const pages = await Promise.all(
      wanted.map(async (mediaType) => {
        const params: Record<string, string> = {
          ...this.browseParams(mediaType, query.sort),
          page: String(page),
          include_adult: "false",
        };
        const genre = genreFor[mediaType];
        if (genre !== undefined) params.with_genres = String(genre);

        const data = await this.request<RawPage>(`/discover/${mediaType}`, params);
        return { items: this.toPosterItems(data.results, { mediaType, releasedOnly: true }), data };
      }),
    );

    return {
      page,
      total_pages: Math.max(1, ...pages.map(({ data }) => Math.min(data.total_pages ?? 1, MAX_PAGE))),
      total_results: pages.reduce((sum, { data }) => sum + (data.total_results ?? 0), 0),
      results: this.interleave(pages.map(({ items }) => items)),
    };
  }

  /** Every genre TMDB knows, merged by name across movies and shows. */
  public async genres(): Promise<GenreEntry[]> {
    return this.cached(
      "genres",
      async () => {
        const [movie, tv] = await Promise.all([
          this.request<RawGenreList>("/genre/movie/list"),
          this.request<RawGenreList>("/genre/tv/list"),
        ]);

        // Merge the two numbering schemes under one name
        const byName = new Map<string, GenreEntry>();
        for (const genre of movie.genres ?? []) {
          byName.set(genre.name, { name: genre.name, movie: genre.id, tv: null });
        }
        for (const genre of tv.genres ?? []) {
          const entry = byName.get(genre.name) ?? { name: genre.name, movie: null, tv: null };
          byName.set(genre.name, { ...entry, tv: genre.id });
        }

        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
      },
      LONG_CACHE_TTL_MS,
    );
  }

  /**
   * Title cards for a batch of TMDB identities. Each card is cached on its
   * own, so a library that grows by one title costs one lookup. Titles TMDB
   * cannot resolve are left out rather than failing the batch.
   */
  public async cards(keys: Array<{ mediaType: TMDBMediaType; id: number }>): Promise<TitleCard[]> {
    const cards = await this.pool(keys, CARD_CONCURRENCY, ({ mediaType, id }) =>
      this.cached(`card:${mediaType}:${id}`, () => this.loadCard(mediaType, id), LONG_CACHE_TTL_MS).catch(
        (error) => {
          console.error(`[TMDB] Card ${mediaType}/${id} failed:`, error);
          return null;
        },
      ),
    );

    return cards.filter((card): card is TitleCard => card !== null);
  }

  /** Reads one title's details and trims them to a card. */
  private async loadCard(mediaType: TMDBMediaType, id: number): Promise<TitleCard> {
    const data = await this.request<RawCardDetails>(`/${mediaType}/${id}`);
    const date = (mediaType === "movie" ? data.release_date : data.first_air_date) ?? "";

    return {
      id,
      media_type: mediaType,
      title: (mediaType === "movie" ? data.title : data.name) ?? "",
      year: date.slice(0, 4),
      poster_path: data.poster_path ?? null,
      backdrop_path: data.backdrop_path ?? null,
      genres: (data.genres ?? []).map((genre) => genre.name),
      vote_average: data.vote_average ?? 0,
      number_of_seasons: mediaType === "tv" ? data.number_of_seasons ?? null : null,
    };
  }

  /** Discover parameters that produce each browse ordering for one media kind. */
  private browseParams(mediaType: TMDBMediaType, sort: BrowseSort): Record<string, string> {
    const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";

    switch (sort) {
      case "popular":
        return { sort_by: "popularity.desc" };
      case "rated":
        // Enough votes that a handful of perfect scores cannot top the list
        return { sort_by: "vote_average.desc", "vote_count.gte": mediaType === "movie" ? "300" : "150" };
      case "recent":
        // Already out, and noticed by enough people to be a real release
        return {
          sort_by: `${dateField}.desc`,
          [`${dateField}.lte`]: new Date().toISOString().slice(0, 10),
          "vote_count.gte": "20",
        };
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

  /**
   * The facts a download needs about a title: its name and year for naming,
   * its overview for the relevance filter, and its IMDb and TVDB ids for
   * indexer searches.
   */
  public async titleFacts(mediaType: TMDBMediaType, id: number): Promise<TitleFacts> {
    const data = await this.request<RawTitleDetails>(`/${mediaType}/${id}`, {
      append_to_response: "external_ids",
    });

    // Movies and shows name the same facts differently
    const name = (mediaType === "movie" ? data.title : data.name) ?? "";
    const date = mediaType === "movie" ? data.release_date : data.first_air_date;
    if (!name) throw new TMDBError(`TMDB has no name for ${mediaType}/${id}`);

    return {
      name,
      year: date ? Number(date.slice(0, 4)) : null,
      overview: data.overview ?? "",
      imdbId: data.external_ids?.imdb_id || null,
      tvdbId: data.external_ids?.tvdb_id || null,
    };
  }

  /** Every episode TMDB lists for a season, in order, with air dates. */
  public async seasonEpisodes(tvId: number, season: number): Promise<SeasonEpisode[]> {
    const data = await this.request<RawSeason>(`/tv/${tvId}/season/${season}`);

    return (data.episodes ?? [])
      .map((episode) => ({ number: episode.episode_number, airDate: episode.air_date || null }))
      .sort((a, b) => a.number - b.number);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                                */
  /* ---------------------------------------------------------------------- */

  /** Performs a GET against TMDB with the API key applied. */
  private async request<T = unknown>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const key = SettingsStore.section("services").tmdbApiKey;
    if (!key) throw new TMDBError("The TMDB API key is not configured");

    const url = new URL(`${BASE_URL}${path}`);
    url.search = new URLSearchParams({ ...params, api_key: key }).toString();

    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch((error) => {
      throw new TMDBError(`TMDB request failed: ${error}`);
    });

    if (!res.ok) {
      throw new TMDBError(`TMDB responded with ${res.status} for ${path}`);
    }

    return res.json() as Promise<T>;
  }

  /** Returns the cached value for a key, loading and storing it when stale. */
  private async cached<T>(key: string, load: () => Promise<T>, ttlMs = CACHE_TTL_MS): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;

    const value = await load();
    this.cache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }

  /** Maps every input through `work` with at most `limit` calls in flight, keeping order. */
  private async pool<I, O>(inputs: I[], limit: number, work: (input: I) => Promise<O>): Promise<O[]> {
    const results = new Array<O>(inputs.length);
    let next = 0;

    // Each runner claims the next unclaimed input until none remain
    const runner = async () => {
      while (next < inputs.length) {
        const index = next++;
        results[index] = await work(inputs[index] as I);
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, runner));
    return results;
  }

  /** Alternates items from several ranked lists, dropping repeats. */
  private interleave(lists: PosterItem[][]): PosterItem[] {
    const merged: PosterItem[] = [];
    const seen = new Set<string>();
    const longest = Math.max(0, ...lists.map((list) => list.length));

    for (let index = 0; index < longest; index++) {
      for (const list of lists) {
        const item = list[index];
        if (!item) continue;

        const key = `${item.media_type}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }

    return merged;
  }

  /** Maps TMDB list entries to poster items, dropping anything unrenderable. */
  private toPosterItems(items: RawItem[] = [], options: MapOptions = {}): PosterItem[] {
    const { mediaType, requirePoster = true, releasedOnly = false } = options;
    const today = new Date().toISOString().slice(0, 10);

    return items.reduce<PosterItem[]>((acc, raw) => {
      const type = mediaType ?? (raw.media_type as TMDBMediaType | undefined);
      if (type !== "movie" && type !== "tv") return acc;

      const title = type === "movie" ? raw.title : raw.name;
      if (!title) return acc;
      if (requirePoster && !raw.poster_path) return acc;

      const date = type === "movie" ? raw.release_date : raw.first_air_date;
      if (releasedOnly && (!date || date > today)) return acc;

      acc.push({
        id: raw.id,
        media_type: type,
        title,
        poster_path: raw.poster_path,
        vote_average: raw.vote_average ?? 0,
        ...(date ? { year: date.slice(0, 4) } : {}),
        backdrop_path: raw.backdrop_path ?? null,
        ...(raw.genre_ids ? { genre_ids: raw.genre_ids } : {}),
        ...(raw.overview ? { overview: raw.overview } : {}),
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
