/**
 * Scoring weights and lookup tables used by the release scorer.
 * Tuned for limited-storage hardware — compact, high-quality files are
 * strongly preferred over raw quality or large remuxes.
 */

export const scoringWeights = {
  resolution: 30,
  fileSize: 25,
  seeders: 25,
  codec: 20,
  releaseType: 20,
  releaseGroup: 5,
  uploadDate: 3,
  /** Corrected re-releases fix a known defect in the original, so nudge them up. */
  repack: 2,
  penaltyBloated4K: -15,
} as const;

/**
 * The size, per movie or per episode, that scores best. Scores fall away on a
 * bell curve either side, so both starved encodes and bloated ones lose out.
 */
export const idealSizeGB = {
  movie: 4,
  episode: 1.2,
} as const;

/** Seeder count beyond which more seeders stop adding score. */
export const seederCap = 1000;

/** 2160p releases bigger than this, per movie or episode, take the bloat penalty. */
export const bloated4KSizeGB = 20;

export const defaultResolutionRank: Record<string, number> = {
  "1080p": 3,
  "720p": 2,
  "2160p": 1,
  "480p": 0,
};

export const releaseTypeRank: Record<string, number> = {
  "WEB-DL": 7,
  WEBRip: 6,
  BluRay: 5,
  HDTV: 4,
  HDRip: 3,
  BDRip: 2,
  DVDRip: 1,
  Remux: 0,
};

export const codecRank: Record<string, number> = {
  AV1: 3,
  x265: 2,
  x264: 1,
};

export const reputableGroups = new Set([
  "SPARKS", "YIFY", "YTS", "EZTV", "FGT", "PSYCHD", "TERMINAL", "TIGOLE", "QXR",
  "RARBG", "EVO", "AMIABLE", "GECKOS", "STUTTERSHIT", "NTB", "FLUX",
  "CMRG", "SMURF", "NOGRP", "MZABI", "ION10", "PAXA", "BAKED",
]);
