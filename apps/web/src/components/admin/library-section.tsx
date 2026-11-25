import type { AdminLibrary } from "@findr/types/admin"
import { formatBytes, plural } from "@/lib/format"
import { cardKey, type useTitleCards } from "@/lib/title-cards"
import { EmptyNote, Figure, Panel, ShareBar } from "@/components/admin/charts"
import { shares } from "@/components/admin/series"

/** The format groups, in order, each with the part picked out in amber. */
const GROUPS: Array<{ key: keyof AdminLibrary["mix"]; label: string; highlight: string }> = [
  { key: "resolution", label: "Resolution", highlight: "4K" },
  { key: "video", label: "Video", highlight: "HEVC" },
  { key: "range", label: "HDR", highlight: "HDR10" },
  { key: "audio", label: "Audio", highlight: "" },
]

interface LibrarySectionProps {
  library: AdminLibrary
  cards: ReturnType<typeof useTitleCards>
}

/** What the library holds: its size in a few large numbers, the biggest titles, and its formats. */
export function LibrarySection({ library, cards }: LibrarySectionProps) {
  const totals = [
    { label: "Movies", value: library.movies },
    { label: "Shows", value: library.shows },
    { label: "Episodes", value: library.episodes },
    { label: "Hours to watch", value: library.durationMs / 3_600_000 },
  ]
  const files = library.movies + library.episodes

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Panel title="In the library" aside={library.bytes > 0 ? formatBytes(library.bytes) : undefined} className="lg:col-span-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          {totals.map((total) => (
            <div key={total.label}>
              <p className="display text-5xl text-ink">
                <Figure value={total.value} format={(value) => Math.round(value).toLocaleString()} />
              </p>
              <p className="mt-1 text-[0.8125rem] text-ink-2">{total.label}</p>
            </div>
          ))}
        </div>
        {library.largest.length > 0 && (
          <>
            <p className="mb-2 mt-8 text-[0.8125rem] text-ink-2">Taking the most space</p>
            <ul className="flex flex-col">
              {library.largest.map((title) => {
                const card = cards(cardKey(title.mediaType, title.tmdbId))
                return (
                  <li key={title.titleId} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate text-ink">
                      {card?.title ?? "Loading…"}
                      {title.mediaType === "tv" && <span className="text-ink-3"> · {plural(title.files, "episode")}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[0.8125rem] text-ink-2 tabular">{formatBytes(title.bytes)}</span>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="File formats" description="What the library's files are made of, by share of files." aside={files > 0 ? plural(files, "file") : undefined} className="lg:col-span-7">
        {files === 0 ? (
          <EmptyNote>Formats show up once something is in the library.</EmptyNote>
        ) : (
          <div className="flex flex-col gap-6">
            {GROUPS.map((group) => {
              const parts = shares(library.mix[group.key])
              const highlight = parts.findIndex((part) => part.label === group.highlight)
              return (
                <div key={group.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[6.5rem_1fr] sm:gap-4">
                  <span className="pt-0.5 text-sm font-medium text-ink">{group.label}</span>
                  <ShareBar parts={parts} highlight={highlight === -1 ? undefined : highlight} />
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}
