import Adapter, { type AdapterSearchParams, type Torrent } from "../types/Adapter";
import { parseTorrentTitle } from "../lib/parseTorrentTitle";

const BASE_URL = "https://eztvx.to/api";

interface EzTvTorrent {
  title: string;
  filename: string;
  magnet_url: string;
  imdb_id: string;
  season: string;
  seeds: number;
  peers: number;
  size_bytes: string;
  date_released_unix: number;
}

interface EzTvResponse {
  torrents_count: number;
  torrents: EzTvTorrent[] | null;
}

/** Strips the "tt" prefix — EZTV requires the numeric portion only. */
function numericImdbId(id: string): string {
  return id.startsWith("tt") ? id.slice(2) : id;
}

/**
 * Adapter for the EZTV torrent API (TV shows).
 *
 * EZTV only accepts an IMDb ID — year and season are filtered locally.
 * Resolution and codec are parsed from the torrent filename.
 */
export default class EzTv extends Adapter {
  protected static override readonly timeout = 15_000;

  async search(ops: AdapterSearchParams): Promise<[Torrent]> {
    const torrents = await this.fetchAll(ops.imdbId);
    const filtered = this.filter(torrents, ops);

    return filtered
      .sort((a, b) => b.seeders - a.seeders)
      .slice(0, 5) as [Torrent];
  }

  /** Fetches all pages from the EZTV API. */
  private async fetchAll(imdbId: string): Promise<EzTvTorrent[]> {
    const id = numericImdbId(imdbId);
    const all: EzTvTorrent[] = [];
    let page = 1;
    let total = Infinity;

    while (all.length < total && page <= 20) {
      const url = `${BASE_URL}/get-torrents?imdb_id=${id}&limit=100&page=${page}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(EzTv.timeout) });
      if (!res.ok) throw new Error(`EZTV returned ${res.status}`);

      const body = (await res.json()) as EzTvResponse;
      if (!body.torrents?.length) break;

      total = body.torrents_count;
      all.push(...body.torrents);
      page++;
    }

    return all;
  }

  /** Matches titles containing an episode indicator (e.g. S01E05, E05). */
  private static readonly EPISODE_PATTERN = /S\d+E\d+|(?<!\w)E\d+/i;

  /**
   * Filters by season and keeps only season packs (titles with a season
   * number but no episode number), then maps to Torrent.
   */
  private filter(torrents: EzTvTorrent[], ops: AdapterSearchParams): Torrent[] {
    const results: Torrent[] = [];

    for (const t of torrents) {
      const season = parseInt(t.season, 10);
      if (ops.season !== undefined && season !== ops.season) continue;
      if (ops.season !== undefined && EzTv.EPISODE_PATTERN.test(t.title)) continue;

      const parsed = parseTorrentTitle(t.filename);
      results.push({
        title: t.title,
        season,
        ...parsed,
        magnetLink: t.magnet_url,
        sizeMB: Math.round(parseInt(t.size_bytes, 10) / 1_048_576),
        seeders: t.seeds,
        leechers: t.peers,
        uploadedAt: new Date(t.date_released_unix * 1000),
      });
    }

    return results;
  }
}
