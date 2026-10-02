/**
 * TMDB image URLs. Sizes are named for where they are used, so every poster of
 * a kind loads the same file and the browser cache does the rest.
 */

const BASE = "https://image.tmdb.org/t/p"

/** Image widths TMDB serves, by the job they do. */
const SIZES = {
  thumb: "w92",
  poster: "w342",
  posterLarge: "w500",
  backdrop: "w780",
  backdropLarge: "w1280",
  profile: "w185",
} as const

export type ImageSize = keyof typeof SIZES

/** The URL for a TMDB image path at a named size, or null when there is no image. */
export function tmdbImage(path: string | null | undefined, size: ImageSize): string | null {
  return path ? `${BASE}/${SIZES[size]}${path}` : null
}
