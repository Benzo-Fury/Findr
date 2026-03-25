/**
 * Scoring weights and lookup tables used by the Resolver.
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
  penaltyBloated4K: -15,
} as const;

export const defaultResolutionRank: Record<string, number> = {
  "1080p": 3,
  "720p": 2,
  "2160p": 1,
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
  "SPARKS", "YIFY", "EZTV", "FGT", "PSYCHD", "TERMiNAL", "TIGOLE", "QXR",
  "RARBG", "EVO", "AMIABLE", "GECKOS", "STUTTERSHIT", "NTb", "FLUX",
  "CMRG", "SMURF", "NOGRP", "MZABI", "ION10", "PAXA", "BAKED",
]);
