import type {
  Resolution,
  VideoCodec,
  AudioCodec,
  HDRFormat,
  ReleaseType,
} from "@findr/types";

/**
 * Torrent result returned from services/adapters.
 */
export interface Torrent {
  title: string; // Title provided directly from torrent source
  season?: number;
  resolution?: Resolution;
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  hdrFormat?: HDRFormat;
  releaseType?: ReleaseType;

  magnetLink: string; // Download link
  sizeMB: number; // Size in MB
  seeders: number;
  leechers: number;
  /** When the torrent was first uploaded to the source. */
  uploadedAt?: Date;
  /** Source-specific identifier for the uploader, used for reputation tracking. */
  uploaderName?: string;
}

export interface AdapterSearchParams {
  imdbId: string;
  season?: number; // If query is a series, season must be set.
}

/**
 * @usage
 * class EzTV extends Adapter {
 *   public query(ops) {
 *     // Query eztv
 *     // Return parsed results
 *   }
 * }
 *
 * const eztv = new EzTv();
 *
 * eztv.query(params)
 */
export default abstract class Adapter {
  protected static readonly timeout = 15_000;

  abstract search(ops: AdapterSearchParams): Promise<[Torrent]>;
}
