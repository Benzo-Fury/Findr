import * as React from "react"
import { Dialog } from "@base-ui/react/dialog"
import { AnimatePresence, motion } from "motion/react"
import { ArrowRightIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react"
import { searchTMDB } from "@/lib/api"
import { DOWNLOAD_STATUS } from "@/lib/download-status"
import { useLibrary, type LibraryEntry } from "@/lib/library"
import { FADE, SPRING_PANEL, staggerDelay } from "@/lib/motion"
import { useIsPhone } from "@/lib/responsive"
import { matchesAll, queryWords } from "@/lib/search"
import { cardKey } from "@/lib/title-cards"
import type { TitleRef } from "@/lib/title-route"
import type { MediaType, PosterItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Highlight } from "@/components/ui/highlight"
import { Kbd } from "@/components/ui/kbd"
import { Poster } from "@/components/ui/poster"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onPick: (ref: TitleRef) => void
}

/** Library matches shown before TMDB's. */
const LIBRARY_LIMIT = 5

/** Pause after typing before TMDB is asked. */
const DEBOUNCE_MS = 220

/** One row the palette can pick. */
interface Result {
  key: string
  ref: TitleRef
  title: string
  year: string
  mediaType: MediaType
  posterPath: string | null
  entry: LibraryEntry | undefined
}

/**
 * Search everything from anywhere. Titles already in the library answer
 * instantly from memory; TMDB answers a moment later below them. Arrow keys
 * move through both lists and Enter opens the title.
 */
export function CommandPalette({ open, onClose, onPick }: CommandPaletteProps) {
  const phone = useIsPhone()
  const inputRef = React.useRef<HTMLInputElement>(null)

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal keepMounted>
            <Dialog.Backdrop
              render={<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE} />}
              className="fixed inset-0 z-[var(--z-overlay)] bg-veil backdrop-blur-[3px]"
            />
            <Dialog.Popup
              initialFocus={inputRef}
              render={
                <motion.div
                  initial={phone ? { opacity: 0, y: 24 } : { opacity: 0, y: -12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={phone ? { opacity: 0, y: 24 } : { opacity: 0, y: -8, scale: 0.98 }}
                  transition={SPRING_PANEL}
                />
              }
              className={cn(
                "fixed z-[var(--z-overlay)] flex flex-col overflow-hidden bg-surface shadow-float outline-none",
                "inset-0 md:inset-auto md:left-1/2 md:top-[11vh] md:max-h-[70vh] md:w-[min(42rem,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-panel",
              )}
            >
              <Dialog.Title className="sr-only">Search titles</Dialog.Title>
              <PaletteBody inputRef={inputRef} onClose={onClose} onPick={onPick} />
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

interface PaletteBodyProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  onClose: () => void
  onPick: (ref: TitleRef) => void
}

function PaletteBody({ inputRef, onClose, onPick }: PaletteBodyProps) {
  const { entries, byKey } = useLibrary()
  const [query, setQuery] = React.useState("")
  const [remote, setRemote] = React.useState<PosterItem[]>([])
  const [searching, setSearching] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const listId = React.useId()
  const words = React.useMemo(() => queryWords(query), [query])

  // TMDB, debounced and cancelled whenever the query moves on
  React.useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setRemote([])
      setSearching(false)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchTMDB(trimmed, { signal: controller.signal })
        .then((page) => setRemote(page.results))
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  // Library matches, or the most recently active titles before anything is typed
  const local = React.useMemo<Result[]>(() => {
    const pool = words.length === 0 ? entries : entries.filter((entry) => entry.card && matchesAll(entry.card.title, words))
    return pool.slice(0, LIBRARY_LIMIT).map((entry) => ({
      key: entry.key,
      ref: { mediaType: entry.title.mediaType, id: entry.title.tmdbId },
      title: entry.card?.title ?? "Loading…",
      year: entry.card?.year ?? "",
      mediaType: entry.title.mediaType,
      posterPath: entry.card?.posterPath ?? null,
      entry,
    }))
  }, [entries, words])

  // TMDB results, without the ones already listed from the library
  const fromTmdb = React.useMemo<Result[]>(() => {
    const shown = new Set(local.map((result) => result.key))
    return remote
      .map((item) => {
        const key = cardKey(item.mediaType, item.id)
        return {
          key,
          ref: { mediaType: item.mediaType, id: item.id },
          title: item.title,
          year: item.year ?? "",
          mediaType: item.mediaType,
          posterPath: item.posterPath,
          entry: byKey.get(key),
        }
      })
      .filter((result) => !shown.has(result.key))
      .slice(0, 12)
  }, [remote, local, byKey])

  const all = React.useMemo(() => [...local, ...fromTmdb], [local, fromTmdb])

  React.useEffect(() => setActiveIndex(0), [query])

  function pick(result: Result | undefined) {
    if (!result) return
    onClose()
    onPick(result.ref)
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((index) => (all.length === 0 ? 0 : (index + step + all.length) % all.length))
    } else if (event.key === "Enter") {
      event.preventDefault()
      pick(all[activeIndex])
    }
  }

  // Keep the active option in view as the keys move it
  React.useEffect(() => {
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, listId])

  const trimmed = query.trim()

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 md:px-5">
        <MagnifyingGlassIcon aria-hidden weight="bold" className="size-5 shrink-0 text-ink-2" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={all[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          aria-label="Search titles"
          placeholder="Search movies and shows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          className="h-12 min-w-0 flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-ink-3"
        />
        <Dialog.Close
          aria-label="Close search"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-sunken hover:text-ink md:hidden"
        >
          <XIcon weight="bold" className="size-5" />
        </Dialog.Close>
        <Kbd className="hidden md:inline-flex">Esc</Kbd>
      </div>

      <div id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {local.length > 0 && (
          <Group label={words.length ? "In your library" : "Recent in your library"}>
            {local.map((result, index) => (
              <Option key={result.key} id={`${listId}-${index}`} result={result} words={words} active={index === activeIndex} index={index} onHover={() => setActiveIndex(index)} onPick={() => pick(result)} />
            ))}
          </Group>
        )}

        {trimmed.length >= 2 && (
          <Group label="From TMDB">
            {searching && fromTmdb.length === 0
              ? Array.from({ length: 3 }, (_, index) => <OptionSkeleton key={index} />)
              : fromTmdb.map((result, offset) => {
                  const index = local.length + offset
                  return (
                    <Option key={result.key} id={`${listId}-${index}`} result={result} words={words} active={index === activeIndex} index={offset} onHover={() => setActiveIndex(index)} onPick={() => pick(result)} />
                  )
                })}
            {!searching && fromTmdb.length === 0 && local.length === 0 && (
              <p className="px-3 py-6 text-[0.9375rem] text-ink-2">
                Nothing found for <span className="font-semibold text-ink">“{trimmed}”</span>. Try the original title or fewer words.
              </p>
            )}
          </Group>
        )}

        {trimmed.length < 2 && local.length === 0 && (
          <p className="px-3 py-6 text-[0.9375rem] text-ink-2">Type a title to search TMDB.</p>
        )}
      </div>

      <div className="hidden items-center gap-4 border-t border-line px-5 py-2.5 text-micro text-ink-3 md:flex">
        <span className="inline-flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
        <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd> to open</span>
      </div>
    </>
  )
}

interface GroupProps {
  label: string
  children: React.ReactNode
}

function Group({ label, children }: GroupProps) {
  return (
    <div role="group" aria-label={label} className="mb-2">
      <p className="px-3 pb-1.5 pt-2 text-micro font-semibold text-ink-3">{label}</p>
      {children}
    </div>
  )
}

interface OptionProps {
  id: string
  result: Result
  words: string[]
  active: boolean
  index: number
  onHover: () => void
  onPick: () => void
}

function Option({ id, result, words, active, index, onHover, onPick }: OptionProps) {
  const latest = result.entry?.latest

  return (
    <motion.div
      id={id}
      role="option"
      aria-selected={active}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...FADE, delay: staggerDelay(index) }}
      onPointerMove={onHover}
      onClick={onPick}
      className={cn(
        "relative flex cursor-pointer items-center gap-3 rounded-[0.875rem] px-3 py-2 transition-colors duration-150",
        active ? "bg-sunken" : "bg-transparent",
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-3 left-0 w-1 rounded-full bg-signal" />}
      <Poster path={result.posterPath} title={result.title} size="thumb" className="w-10 shrink-0 rounded-[0.375rem]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.9375rem] font-semibold text-ink">
          <Highlight text={result.title} words={words} />
        </p>
        <p className="text-micro text-ink-3">
          <span className="font-mono tabular">{result.year || "No date"}</span> · {result.mediaType === "tv" ? "Series" : "Film"}
        </p>
      </div>
      {latest ? (
        <StatusLabel status={DOWNLOAD_STATUS[latest.status]} className="shrink-0 text-micro" />
      ) : (
        <ArrowRightIcon aria-hidden weight="bold" className={cn("size-4 shrink-0 text-ink-3 transition-[opacity,transform] duration-200", active ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0")} />
      )}
    </motion.div>
  )
}

function OptionSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Skeleton className="aspect-[2/3] w-10 rounded-[0.375rem]" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/5 rounded-full" />
        <Skeleton className="h-2.5 w-1/5 rounded-full" />
      </div>
    </div>
  )
}
