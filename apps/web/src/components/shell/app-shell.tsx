import * as React from "react"
import { Outlet } from "react-router-dom"
import type { Session } from "@/lib/auth"
import { useLibrary } from "@/lib/library"
import { useTitleRoute } from "@/lib/title-route"
import { BottomTabs } from "@/components/shell/bottom-tabs"
import { CommandPalette } from "@/components/shell/command-palette"
import { TopBar } from "@/components/shell/top-bar"
import { TitleSheet } from "@/components/title/title-sheet"

interface AppShellProps {
  session: Session
}

/** Whether a key event started in a place that takes typing. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/**
 * The frame around every signed-in page: navigation, the search palette and
 * the title sheet, which any page can open through the URL.
 *
 * Shortcuts: ⌘K or Ctrl+K opens search anywhere. `/` focuses the page's own
 * search field when it has one (marked `data-page-search`), and opens the
 * palette otherwise.
 */
export function AppShell({ session }: AppShellProps) {
  const { active } = useLibrary()
  const { open, openTitle, closeTitle } = useTitleRoute()
  const [searchOpen, setSearchOpen] = React.useState(false)
  const openSearch = React.useCallback(() => setSearchOpen(true), [])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearchOpen((current) => !current)
        return
      }
      if (event.key === "/" && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        const pageSearch = document.querySelector<HTMLInputElement>("[data-page-search]")
        if (pageSearch) pageSearch.focus()
        else setSearchOpen(true)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div className="min-h-[100dvh]">
      <a
        href="#main"
        className="sr-only z-[var(--z-toast)] rounded-full bg-ink px-4 py-2 text-surface focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to content
      </a>
      <TopBar session={session} activeCount={active.length} onSearch={openSearch} />
      <main id="main" className="pb-[calc(var(--tabs-height)+env(safe-area-inset-bottom)+2rem)] md:pb-16">
        <Outlet />
      </main>
      <BottomTabs activeCount={active.length} onSearch={openSearch} />
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={openTitle} />
      <TitleSheet titleRef={open} onClose={closeTitle} onOpenTitle={openTitle} />
    </div>
  )
}
