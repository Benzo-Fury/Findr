import * as React from "react"
import { motion } from "motion/react"
import { useInfiniteScroll } from "@/lib/hooks"
import { EASE_OUT, staggerDelay } from "@/lib/motion"
import type { PosterItem } from "@/lib/types"
import { PosterCard } from "@/components/media/poster-card"
import { usePosterActions } from "@/components/media/use-poster-actions"
import { Skeleton } from "@/components/ui/skeleton"

interface PosterGridProps {
  items: PosterItem[]
  /** Shared-element scope for the posters in this grid. */
  scope: string
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
}

/** Columns that fit at every width, kept in one place so skeletons match. */
const GRID_CLASS = "grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:gap-x-5 md:gap-y-8 lg:grid-cols-5 xl:grid-cols-7 2xl:grid-cols-8"

/**
 * An endless grid of posters. Each page that arrives cascades in from where
 * the last one ended; a sentinel well below the fold asks for the next page
 * before the reader gets there.
 */
export function PosterGrid({ items, scope, loading, loadingMore, hasMore, onLoadMore }: PosterGridProps) {
  const { open, known, layoutIdFor } = usePosterActions(scope)
  const sentinel = useInfiniteScroll(onLoadMore, hasMore, loadingMore)

  // Items already shown when the latest page arrived do not animate again
  const settled = React.useRef(0)
  const firstNew = settled.current
  React.useEffect(() => {
    settled.current = items.length
  }, [items.length])

  if (loading) return <PosterGridSkeleton />

  return (
    <>
      <div className={GRID_CLASS}>
        {items.map((item, index) => {
          const state = known(item)
          const fresh = index >= firstNew
          return (
            <motion.div
              key={`${item.mediaType}-${item.id}`}
              initial={fresh ? { opacity: 0, y: 18 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: EASE_OUT, delay: fresh ? staggerDelay(index - firstNew) : 0 }}
            >
              <PosterCard
                title={item.title}
                year={item.year}
                mediaType={item.mediaType}
                posterPath={item.posterPath}
                rating={item.voteAverage}
                status={state?.status}
                progress={state?.progress}
                layoutId={layoutIdFor(item)}
                onOpen={() => open(item)}
              />
            </motion.div>
          )
        })}
        {loadingMore && Array.from({ length: 7 }, (_, index) => <CardSkeleton key={`more-${index}`} />)}
      </div>
      {hasMore && <div ref={sentinel} aria-hidden className="h-px" />}
    </>
  )
}

function CardSkeleton() {
  return (
    <div>
      <Skeleton className="aspect-[2/3] w-full" />
      <Skeleton className="mt-3 h-3.5 w-3/4 rounded-full" />
      <Skeleton className="mt-2 h-2.5 w-1/3 rounded-full" />
    </div>
  )
}

/** The grid's loading state, the same shape as the grid. */
export function PosterGridSkeleton() {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: 16 }, (_, index) => (
        <CardSkeleton key={index} />
      ))}
    </div>
  )
}
