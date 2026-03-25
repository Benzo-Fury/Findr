/** Video resolution tiers. */
export type Resolution = "720p" | "1080p" | "2160p";

/** Common video codecs used in torrent releases. */
export type VideoCodec = "x264" | "x265" | "AV1";

/** Common audio codecs used in torrent releases. */
export type AudioCodec = "AAC" | "DTS" | "DolbyAtmos" | "TrueHD" | "FLAC" | "EAC3";

/** HDR format indicators. */
export type HDRFormat = "SDR" | "HDR10" | "DolbyVision";

/**
 * Release types ordered roughly by quality.
 * CAM and TS are blacklisted by default.
 */
export type ReleaseType = "CAM" | "TS" | "SCR" | "DVDRip" | "HDTV" | "WEBRip" | "WEB-DL" | "HDRip" | "BDRip" | "BluRay" | "Remux";

export type MediaType = "movie" | "series";
