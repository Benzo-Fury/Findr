import { z } from "zod";

/** Video resolution tiers. 480p stands in for every SD release. */
export const ResolutionSchema = z.enum(["480p", "720p", "1080p", "2160p"]);
export type Resolution = z.infer<typeof ResolutionSchema>;

/** Common video codecs used in torrent releases. */
export const VideoCodecSchema = z.enum(["x264", "x265", "AV1"]);
export type VideoCodec = z.infer<typeof VideoCodecSchema>;

/** Common audio codecs used in torrent releases. */
export const AudioCodecSchema = z.enum(["AAC", "DTS", "DolbyAtmos", "TrueHD", "FLAC", "EAC3"]);
export type AudioCodec = z.infer<typeof AudioCodecSchema>;

/** HDR format indicators. */
export const HDRFormatSchema = z.enum(["SDR", "HDR10", "DolbyVision"]);
export type HDRFormat = z.infer<typeof HDRFormatSchema>;

/**
 * Release types ordered roughly by quality.
 * CAM and TS are blacklisted by default.
 */
export const ReleaseTypeSchema = z.enum([
  "CAM",
  "TS",
  "SCR",
  "DVDRip",
  "HDTV",
  "WEBRip",
  "WEB-DL",
  "HDRip",
  "BDRip",
  "BluRay",
  "Remux",
]);
export type ReleaseType = z.infer<typeof ReleaseTypeSchema>;

/** Findr's own media kinds. TMDB calls series "tv", which is what Findr uses too. */
export const MediaTypeSchema = z.enum(["movie", "tv"]);
export type MediaType = z.infer<typeof MediaTypeSchema>;
