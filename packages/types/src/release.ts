import { z } from "zod";
import {
  AudioCodecSchema,
  HDRFormatSchema,
  ReleaseTypeSchema,
  ResolutionSchema,
  VideoCodecSchema,
} from "./media";

/**
 * What a release covers, decided from its title.
 *
 * - `movie`: no season or episode markers at all.
 * - `episode`: one or more specific episodes of a single season.
 * - `season`: a whole single season with no episode markers (a season pack).
 * - `multi-season`: two or more seasons in one release.
 * - `complete-series`: advertised as the whole show with no season numbers.
 */
export const ReleaseKindSchema = z.enum([
  "movie",
  "episode",
  "season",
  "multi-season",
  "complete-series",
]);
export type ReleaseKind = z.infer<typeof ReleaseKindSchema>;

/** Everything Findr can read out of a raw release title. */
export const ParsedReleaseSchema = z.object({
  kind: ReleaseKindSchema,
  resolution: ResolutionSchema.nullable(),
  videoCodec: VideoCodecSchema.nullable(),
  audioCodec: AudioCodecSchema.nullable(),
  hdrFormat: HDRFormatSchema.nullable(),
  releaseType: ReleaseTypeSchema.nullable(),
  group: z.string().nullable(),
  year: z.number().int().nullable(),
  /** Seasons covered, ascending. Empty for movies and unnumbered complete series. */
  seasons: z.array(z.number().int()),
  /** Episodes covered within the single season, ascending. Empty unless `kind` is `episode`. */
  episodes: z.array(z.number().int()),
  /** PROPER, REPACK or RERIP — a corrected re-release of an earlier one. */
  isRepack: z.boolean(),
});
export type ParsedRelease = z.infer<typeof ParsedReleaseSchema>;
