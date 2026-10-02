import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge taught the theme's custom scales, so a custom font size such
 * as `text-micro` is not mistaken for a colour and merged away.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["micro"],
      radius: ["art", "panel"],
      shadow: ["lift", "float", "ring"],
      font: ["display", "sans", "mono"],
    },
  },
})

/** Joins class names, letting later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
