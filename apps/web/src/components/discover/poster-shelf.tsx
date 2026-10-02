import type { PosterItem } from "@/lib/types"
import { PosterCard } from "@/components/media/poster-card"
import { usePosterActions } from "@/components/media/use-poster-actions"
import { ScrollRow } from "@/components/ui/scroll-row"

interface PosterShelfProps {
  label: string
  scope: string
  items: PosterItem[]
}

/** A horizontal run of posters that snaps card by card. */
export function PosterShelf({ label, scope, items }: PosterShelfProps) {
  const { open, known, layoutIdFor } = usePosterActions(scope)

  return (
    <ScrollRow label={label} trackClassName="-mx-4 gap-3 px-4 md:-mx-8 md:gap-5 md:px-8">
      {items.map((item) => {
        const state = known(item)
        return (
          <div key={`${item.mediaType}-${item.id}`} className="w-[7.25rem] shrink-0 snap-start sm:w-36 lg:w-44">
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
          </div>
        )
      })}
    </ScrollRow>
  )
}
