/**
 * Motion presets. Every animated component draws its timing from here so the
 * whole app moves with one personality: quick, springy, and never in the way.
 */

import type { Transition } from "motion/react"

/** Snappy spring for controls: indicators, chips, toggles. */
export const SPRING_SNAP: Transition = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 }

/** Softer spring for panels and shared-element moves. */
export const SPRING_PANEL: Transition = { type: "spring", stiffness: 340, damping: 34, mass: 0.9 }

/** Spring for hover lift and tilt. */
export const SPRING_HOVER: Transition = { type: "spring", stiffness: 300, damping: 22 }

/** Expo ease-out for fades and reveals. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

/** Default fade for content that appears or swaps. */
export const FADE: Transition = { duration: 0.32, ease: EASE_OUT }

/** Delay between siblings in a staggered reveal, in seconds. */
export const STAGGER_STEP = 0.028

/** Stagger delays stop growing after this many items, so long lists never wait. */
export const STAGGER_CAP = 14

/** The delay for the item at `index` in a staggered reveal. */
export function staggerDelay(index: number): number {
  return Math.min(index, STAGGER_CAP) * STAGGER_STEP
}
