import type { Resolution, VideoCodec, ReleaseType } from "@findr/types";
import Adapter, { type AdapterSearchParams, type Torrent } from "../types/Adapter";

const BASE_URL = "https://yts.lt/api/v2";

/**
 * YTS returns only torrent hashes, not magnet links. To construct a
 * working magnet URI the client must supply a set of tracker announce
 * URLs so peers can be discovered. These are well-known public trackers
 * that are widely available and don't require registration.
 */
const TRACKERS = [
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.coppersurfer.tk:6969",
  "udp://glotorrents.pw:6969/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://torrent.gresille.org:80/announce",
  "udp://p4p.arenabg.com:1337",
  "udp://tracker.leechers-paradise.org:6969",
];

interface YTSTorrent {
  hash: string;
  quality: string;
  type: string;
  seeds: number;
  peers: number;
  size_bytes: number;
  date_uploaded_unix: number;
}

interface YTSMovie {
  imdb_code: string;
  title_long: string;
  torrents?: YTSTorrent[];
}

interface YTSResponse {
  status: string;
  status_message: string;
  data: { movies?: YTSMovie[] };
}

/**
 * YTS returns a free-text `type` field (e.g. "bluray", "web") rather than
 * a standardised release type. This map normalises those values into our
 * ReleaseType union so downstream consumers get a consistent vocabulary.
 * The generic parseTorrentTitle parser cannot help here because YTS titles
 * don't embed release-type keywords the way scene releases do.
 */
const RELEASE_MAP: Record<string, ReleaseType> = {
  bluray: "BluRay",
  "blu-ray": "BluRay",
  web: "WEB-DL",
  webrip: "WEBRip",
};

/**
 * Adapter for the YTS torrent API (movies).
 *
 * Magnet links are constructed from torrent hashes.
 */
export default class YTS extends Adapter {
  async search(ops: AdapterSearchParams): Promise<[Torrent]> {
    const movies = await this.fetchMovies(ops.imdbId);
    const results = this.toTorrents(movies);

    return results
      .sort((a, b) => b.seeders - a.seeders)
      .slice(0, 5) as [Torrent];
  }

  private async fetchMovies(imdbId: string): Promise<YTSMovie[]> {
    const url = `${BASE_URL}/list_movies.json?query_term=${imdbId}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(YTS.timeout) });
    if (!res.ok) throw new Error(`YTS returned ${res.status}`);

    const body = (await res.json()) as YTSResponse;
    if (body.status !== "ok") throw new Error(`YTS error: ${body.status_message}`);

    return body.data.movies ?? [];
  }

  /** Flattens movies into individual torrent results. */
  private toTorrents(movies: YTSMovie[]): Torrent[] {
    const results: Torrent[] = [];

    for (const movie of movies) {
      if (!movie.torrents) continue;

      for (const t of movie.torrents) {
        results.push({
          title: movie.title_long,
          resolution: this.parseResolution(t.quality),
          videoCodec: this.parseCodec(t.quality),
          releaseType: RELEASE_MAP[t.type.toLowerCase()],
          magnetLink: this.buildMagnet(t.hash, movie.title_long),
          sizeMB: Math.round(t.size_bytes / 1_048_576),
          seeders: t.seeds,
          leechers: t.peers,
          uploadedAt: new Date(t.date_uploaded_unix * 1000),
        });
      }
    }

    return results;
  }

  private buildMagnet(hash: string, title: string): string {
    const dn = encodeURIComponent(title);
    const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
    return `magnet:?xt=urn:btih:${hash}&dn=${dn}${tr}`;
  }

  private parseResolution(quality: string): Resolution | undefined {
    if (quality.startsWith("2160p")) return "2160p";
    if (quality.startsWith("1080p")) return "1080p";
    if (quality.startsWith("720p")) return "720p";
  }

  private parseCodec(quality: string): VideoCodec {
    return quality.includes("x265") ? "x265" : "x264";
  }
}
