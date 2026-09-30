/**
 * Thin client over Prowlarr — the only way Findr searches indexers. Callers
 * hand over the title fields they already have (name, year, IMDb id, season,
 * episode) and get back releases; building Prowlarr's search DSL, picking
 * categories, and normalising the `ReleaseResource` payload all happen here.
 *
 * Prowlarr federates whatever indexers its instance has configured, so a
 * search that returns few results usually means indexers are misconfigured or
 * timing out rather than that no release exists — Prowlarr reports per-indexer
 * failures as a short array, not an error status.
 *
 * The API key never leaves this class. Prowlarr hands back download links
 * with `apikey=` embedded; those are rewritten into key-free `prowlarr:`
 * references before any caller sees them, and the key is only re-attached
 * when this class itself fetches the link from the configured Prowlarr.
 */

import type { MediaType } from "@findr/types/media";
import type { TorrentInput } from "../downloader/Downloader";
import { env } from "../env/Env";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { AttemptFailure, FatalDownloadError } from "../pipeline/errors";

// ---------- Types ---------- //

/** The title fields a search is built from. */
export interface TitleQuery {
  name: string;
  year: number | null;
  /** Null when TMDB has no IMDb id for the title. */
  imdbId: string | null;
  /** Preferred over IMDb for series, which TV indexers key on TVDB. */
  tvdbId?: number | null;
  type: MediaType;
  /** Series only. */
  season?: number;
  /** Series only; narrows a season search to one episode. */
  episode?: number;
}

/**
 * A release as Findr stores it. Carries no secrets: `downloadUrl` is either a
 * key-free `prowlarr:` reference or a third-party URL that never had a key.
 */
export interface ProwlarrRelease {
  /** Release title exactly as the indexer published it. */
  title: string;
  magnetUri: string | null;
  infoHash: string | null;
  downloadUrl: string | null;
  sizeMB: number;
  seeders: number;
  leechers: number;
  /** Name of the indexer that served this release. */
  indexer: string;
  publishedAt: Date | null;
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

// ---------- Constants ---------- //

/** Newznab category roots — 2000 is movies, 5000 is TV. */
const CATEGORIES: Record<MediaType, number> = { movie: 2000, tv: 5000 };

/** Prowlarr's search modes, keyed by the media type being searched. */
const SEARCH_TYPES: Record<MediaType, string> = { movie: "movie", tv: "tvsearch" };

const DEFAULT_LIMIT = 100;
const TIMEOUT_MS = 15_000;

/** Prefix marking a stored link as a path on the configured Prowlarr, minus the key. */
const PROWLARR_REFERENCE = "prowlarr:";

/** `.torrent` files are small; anything bigger is not one. */
const MAX_TORRENT_BYTES = 10 * 1024 * 1024;

// ---------- Client ---------- //

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
  public async search(title: TitleQuery, options: SearchOptions = {}): Promise<ProwlarrRelease[]> {
    // Try the precise id-based query, then widen to text if nothing landed
    const idQuery = this.idQuery(title);
    let releases = idQuery ? await this.request(idQuery, title, options) : [];
    if (releases.length === 0) {
      releases = await this.request(this.textQuery(title), title, options);
    }

    // Drop usenet and linkless entries, then rank by swarm health
    return releases
      .filter((release) => release.protocol !== "usenet")
      .map((release) => this.toRelease(release))
      .filter((release) => release.magnetUri || release.downloadUrl || release.infoHash)
      .sort((a, b) => b.seeders - a.seeders);
  }

  /**
   * Turns a stored release's links into something a torrent client can add.
   * Prefers a real magnet (it carries trackers), then the `.torrent` file,
   * then a bare info-hash magnet, which relies on DHT alone.
   */
  public async resolveTorrent(release: Pick<ProwlarrRelease, "magnetUri" | "downloadUrl" | "infoHash">): Promise<TorrentInput> {
    if (release.magnetUri) return { kind: "magnet", uri: release.magnetUri };

    // Fetch the .torrent, falling back to the hash if the indexer fails
    if (release.downloadUrl) {
      try {
        return await this.fetchTorrent(release.downloadUrl);
      } catch (error) {
        if (!release.infoHash || error instanceof FatalDownloadError) throw error;
      }
    }

    if (release.infoHash) return { kind: "magnet", uri: this.hashMagnet(release.infoHash) };
    throw new AttemptFailure("The release has no usable download link");
  }

  // ---------- Queries ---------- //

  /**
   * Builds the id-based query in Prowlarr's search DSL, narrowed by season and
   * episode for series. TV prefers the TVDB id; null when there is no id.
   */
  private idQuery(title: TitleQuery): string | null {
    const id =
      title.type === "tv" && title.tvdbId
        ? `{TvdbId:${title.tvdbId}}`
        : title.imdbId
          ? `{ImdbId:${title.imdbId}}`
          : null;
    return id ? [id, ...this.episodeTokens(title)].join(" ") : null;
  }

  /** Builds the plain text fallback: name plus year for movies, name plus season tokens for series. */
  private textQuery(title: TitleQuery): string {
    if (title.type === "tv") return [title.name, ...this.episodeTokens(title)].join(" ");
    return title.year ? `${title.name} ${title.year}` : title.name;
  }

  /** Prowlarr's `{Season:N}` and `{Episode:N}` tokens, when present. */
  private episodeTokens(title: TitleQuery): string[] {
    const tokens: string[] = [];
    if (title.season !== undefined) tokens.push(`{Season:${title.season}}`);
    if (title.episode !== undefined) tokens.push(`{Episode:${title.episode}}`);
    return tokens;
  }

  // ---------- Links ---------- //

  /**
   * Downloads a `.torrent` from a stored link. Prowlarr's proxy often answers
   * with a redirect to a magnet instead, which is returned as such.
   */
  private async fetchTorrent(link: string): Promise<TorrentInput> {
    const url = this.linkToUrl(link);

    // Follow redirects by hand so a magnet redirect can be caught
    let response = await this.fetchLink(url, "manual");
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (location.startsWith("magnet:")) return { kind: "magnet", uri: location };
      response = await this.fetchLink(new URL(location, url), "follow");
    }

    if (!response.ok) throw new AttemptFailure(`Indexer returned ${response.status} for the torrent file`);

    // Sanity-check that the body is a bencoded torrent
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_TORRENT_BYTES || bytes[0] !== 0x64) {
      throw new AttemptFailure("Indexer did not return a valid torrent file");
    }
    return { kind: "file", bytes };
  }

  /** Performs the link fetch, treating a dead Prowlarr as fatal and anything else as the release's fault. */
  private async fetchLink(url: URL, redirect: "manual" | "follow"): Promise<Response> {
    try {
      return await fetch(url, { redirect, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (url.origin === this.baseUrl().origin) {
        throw new FatalDownloadError(`Prowlarr is unreachable: ${error}`);
      }
      throw new AttemptFailure(`Could not fetch the torrent file: ${error}`);
    }
  }

  /**
   * Re-attaches the API key to a `prowlarr:` reference, resolved against the
   * configured Prowlarr URL. Third-party links are used exactly as stored.
   */
  private linkToUrl(link: string): URL {
    if (!link.startsWith(PROWLARR_REFERENCE)) return new URL(link);

    const { baseUrl, apiKey } = this.credentials();
    const url = new URL(link.slice(PROWLARR_REFERENCE.length), baseUrl);
    url.searchParams.set("apikey", apiKey);
    return url;
  }

  /**
   * Makes a link from Prowlarr safe to store. Links carrying an API key are
   * Prowlarr proxy links: the key is removed and only the path and query are
   * kept, so the key is not stored and a mismatched hostname (Prowlarr behind
   * Docker, say) cannot misdirect the fetch. Magnets pass through.
   */
  private sanitizeLink(link: string | null | undefined): string | null {
    if (!link) return null;
    if (link.startsWith("magnet:")) return link;

    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return null;
    }

    if (!url.searchParams.has("apikey")) return url.toString();
    url.searchParams.delete("apikey");
    return `${PROWLARR_REFERENCE}${url.pathname}${url.search}`;
  }

  private hashMagnet(infoHash: string): string {
    return `magnet:?xt=urn:btih:${infoHash}`;
  }

  // ---------- Internals ---------- //

  /** Performs a search against Prowlarr with the API key applied. */
  private async request(query: string, title: TitleQuery, options: SearchOptions): Promise<ReleaseResource[]> {
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
      signal: AbortSignal.timeout(TIMEOUT_MS * 4),
    }).catch((error: unknown) => {
      throw new ProwlarrError(`Prowlarr request failed: ${error}`);
    });

    if (!res.ok) {
      throw new ProwlarrError(`Prowlarr responded with ${res.status} for "${query}"`);
    }

    return res.json() as Promise<ReleaseResource[]>;
  }

  /** The configured Prowlarr origin. */
  private baseUrl(): URL {
    return new URL(this.credentials().baseUrl);
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
   * Narrows a Prowlarr release into the stored shape. Prowlarr sometimes puts
   * a proxy link in `magnetUrl`, so that field is only trusted as a magnet
   * when it actually is one.
   */
  private toRelease(release: ReleaseResource): ProwlarrRelease {
    const magnetField = this.sanitizeLink(release.magnetUrl);
    const magnetUri = magnetField?.startsWith("magnet:") ? magnetField : null;
    const downloadUrl = this.sanitizeLink(release.downloadUrl) ?? (magnetUri ? null : magnetField);

    return {
      title: release.title ?? "",
      magnetUri,
      infoHash: release.infoHash ? release.infoHash.toLowerCase() : null,
      downloadUrl,
      sizeMB: Math.round((release.size ?? 0) / 1_048_576),
      seeders: release.seeders ?? 0,
      leechers: release.leechers ?? 0,
      indexer: release.indexer ?? "unknown",
      publishedAt: release.publishDate ? new Date(release.publishDate) : null,
    };
  }
}
