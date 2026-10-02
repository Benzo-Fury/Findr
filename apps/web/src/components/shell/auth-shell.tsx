import * as React from "react"
import { motion } from "motion/react"
import { fetchFeatured } from "@/lib/api"
import { EASE_OUT } from "@/lib/motion"
import { tmdbImage } from "@/lib/tmdb-image"
import type { PosterItem } from "@/lib/types"
import { Brand } from "@/components/shell/brand"

interface AuthShellProps {
  title: string
  description: string
  children: React.ReactNode
}

/** Columns in the poster wall, each drifting at its own pace and direction. */
const COLUMNS = [
  { duration: "95s", direction: "drift-up" },
  { duration: "120s", direction: "drift-down" },
  { duration: "85s", direction: "drift-up" },
  { duration: "110s", direction: "drift-down" },
  { duration: "100s", direction: "drift-up" },
] as const

/**
 * The frame around the screens before the app: sign-in and the first-run
 * credential reset. The form sits on paper to the left; to the right, this
 * week's trending posters drift past in slow columns. On phones the wall
 * becomes a short strip above the form.
 */
export function AuthShell({ title, description, children }: AuthShellProps) {
  const [posters, setPosters] = React.useState<PosterItem[]>([])

  React.useEffect(() => {
    fetchFeatured()
      .then((items) => setPosters(items.filter((item) => item.posterPath)))
      .catch(() => {})
  }, [])

  return (
    <div className="grid min-h-[100dvh] bg-paper lg:grid-cols-[minmax(26rem,5fr)_7fr]">
      <div className="relative order-2 flex flex-col px-6 pb-10 pt-8 sm:px-10 lg:order-1 lg:px-14 lg:py-12">
        <Brand />
        <div className="flex flex-1 items-center py-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE_OUT }}
            className="w-full max-w-sm"
          >
            <h1 className="display text-5xl text-ink sm:text-6xl">{title}</h1>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">{description}</p>
            <div className="mt-8">{children}</div>
          </motion.div>
        </div>
        <p className="text-micro text-ink-3">Artwork from TMDB.</p>
      </div>

      <div aria-hidden className="relative order-1 h-40 overflow-hidden bg-ink sm:h-56 lg:order-2 lg:h-auto">
        {posters.length > 0 && (
          <div className="absolute -inset-x-8 -inset-y-24 grid -rotate-[5deg] grid-cols-5 gap-3 opacity-90 lg:gap-4">
            {COLUMNS.map((column, index) => {
              // Each column gets its own slice, doubled so the loop is seamless
              const slice = [...posters.slice(index * 5), ...posters.slice(0, index * 5)].slice(0, 8)
              return (
                <div key={index} className="flex flex-col gap-3 lg:gap-4" style={{ animation: `${column.direction} ${column.duration} linear infinite` }}>
                  {[...slice, ...slice].map((item, position) => (
                    <img
                      key={`${item.id}-${position}`}
                      src={tmdbImage(item.posterPath, "poster") ?? undefined}
                      alt=""
                      loading="lazy"
                      className="aspect-[2/3] w-full rounded-art object-cover"
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
        <div className="absolute inset-0 -left-px bg-[linear-gradient(to_right,var(--color-paper)_1px,oklch(0.972_0.004_255/0.6)_6%,transparent_22%)] max-lg:bg-[linear-gradient(to_top,var(--color-paper),transparent_45%)]" />
      </div>
    </div>
  )
}
