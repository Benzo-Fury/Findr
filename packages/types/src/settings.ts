import { z } from "zod";
import { ReleaseTypeSchema, ResolutionSchema } from "./media";

/**
 * How candidates are filtered and ranked. Ordered arrays use index as
 * priority — a lower index is preferred.
 */
export const PreferencesSchema = z.object({
  /** Resolutions in order of preference. Anything absent scores nothing for resolution. */
  resolutions: z.array(ResolutionSchema).default(["1080p", "720p", "2160p"]),
  /** Ceiling per movie or per episode; season packs scale it by episode count. */
  maxFileSizeGB: z.number().positive().default(10),
  minSeeders: z.number().int().nonnegative().default(5),
  blacklistedReleaseTypes: z.array(ReleaseTypeSchema).default(["CAM", "TS", "SCR"]),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
