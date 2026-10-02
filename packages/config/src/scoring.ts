/**
 * Lookup tables used by the release scorer. Each ranks the values of one
 * release attribute; the scorer scales a rank by that attribute's weight,
 * which admins tune on the settings page (`scoring` in `@findr/types/settings`).
 * Tuned for limited-storage hardware — compact, high-quality files are
 * strongly preferred over raw quality or large remuxes.
 */

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
