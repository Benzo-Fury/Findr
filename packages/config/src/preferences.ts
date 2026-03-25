import type { Resolution, ReleaseType } from "@findr/types";

/**
 * Default user preferences applied when creating a job.
 * Ordered arrays use index as priority — lower index = higher preference.
 */
export const defaultPreferences = {
  resolutions: ["1080p", "720p", "2160p"] as Resolution[],
  maxFileSizeGB: 10,
  minSeeders: 5,
  blacklistedReleaseTypes: ["CAM", "TS"] as ReleaseType[],
} as const;
