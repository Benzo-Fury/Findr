import type {
  Resolution,
  VideoCodec,
  AudioCodec,
  HDRFormat,
  ReleaseType,
} from "@findr/types";

export interface ParsedTorrentTitle {
  resolution?: Resolution;
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  hdrFormat?: HDRFormat;
  releaseType?: ReleaseType;
  releaseGroup?: string;
}

const RESOLUTION: [RegExp, Resolution][] = [
  [/\b(2160p|4K|UHD)\b/i, "2160p"],
  [/\b(1080p|FHD)\b/i, "1080p"],
  [/\b720p\b/i, "720p"],
];

const VIDEO_CODEC: [RegExp, VideoCodec][] = [
  [/\b(x\.?265|h\.?265|HEVC)\b/i, "x265"],
  [/\b(x\.?264|h\.?264)\b/i, "x264"],
  [/\bAV1\b/i, "AV1"],
];

const AUDIO_CODEC: [RegExp, AudioCodec][] = [
  [/\bAtmos\b/i, "DolbyAtmos"],
  [/\bTrueHD\b/i, "TrueHD"],
  [/\bDTS\b/i, "DTS"],
  [/\b(EAC3|DDP|DD\+|E-AC-3)/i, "EAC3"],
  [/\bFLAC\b/i, "FLAC"],
  [/\bAAC\b/i, "AAC"],
];

const HDR: [RegExp, HDRFormat][] = [
  [/\b(DolbyVision|DoVi|DV)\b/i, "DolbyVision"],
  [/\b(HDR10\+?|HDR)\b/i, "HDR10"],
];

const STREAMING_SOURCE = /\b(AMZN|NF|NETFLIX|DSNP|DISNEY\+?|HMAX|ATVP|PMTP|PCOK|CRAV|iT)\b/i;

const RELEASE_TYPE: [RegExp, ReleaseType][] = [
  [/\bRemux\b/i, "Remux"],
  [/\b(Blu-?Ray|BDRemux)\b/i, "BluRay"],
  [/\bWEB-DL\b/i, "WEB-DL"],
  [/\bWEBRip\b/i, "WEBRip"],
  [/\bWEB\b/i, "WEB-DL"],
  [/\bHDTV\b/i, "HDTV"],
  [/\bHDRip\b/i, "HDRip"],
  [/\bBDRip\b/i, "BDRip"],
  [/\bDVDRip\b/i, "DVDRip"],
  [/\b(CAMRip|HDCAM|CAM)\b/i, "CAM"],
  [/\b(TELESYNC|TELECINE|HDTS|TC)\b(?![\w])/i, "TS"],
  [/\bTS\b(?![\w])/i, "TS"],
  [/\b(SCR|SCREENER|DVDSCR)\b/i, "SCR"],
  [/\b(R5|R6)\b/i, "TS"],
];

function firstMatch<T>(title: string, patterns: [RegExp, T][]): T | undefined {
  for (const [re, value] of patterns) {
    if (re.test(title)) return value;
  }
}

export function parseTorrentTitle(title: string): ParsedTorrentTitle {
  const releaseType = firstMatch(title, RELEASE_TYPE)
    ?? (STREAMING_SOURCE.test(title) ? "WEB-DL" as ReleaseType : undefined);

  const group = title.match(/-([A-Za-z0-9]+)(?:\[.*?\])?\s*$/);

  return {
    resolution: firstMatch(title, RESOLUTION),
    videoCodec: firstMatch(title, VIDEO_CODEC),
    audioCodec: firstMatch(title, AUDIO_CODEC),
    hdrFormat: firstMatch(title, HDR),
    releaseType,
    releaseGroup: group?.[1],
  };
}
