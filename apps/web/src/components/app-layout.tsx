import { Outlet, NavLink, useLocation } from "react-router-dom"
import { Search, Menu, X, LogOut } from "lucide-react"
import { isAdmin, signOut, type Session } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { SearchDialog } from "@/components/search-dialog"
import { TitleDialog } from "@/components/title-dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import type { PosterItem } from "@/lib/types"
import * as React from "react"

interface AppLayoutProps {
  session: Session
}

interface NavItem {
  to: string
  label: string
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Library" },
  { to: "/discover", label: "Discover" },
  { to: "/downloads", label: "Downloads" },
]

/** Only admins can change settings or manage accounts. */
const ADMIN_NAV_ITEMS: NavItem[] = [{ to: "/settings", label: "Settings" }]

export function AppLayout({ session }: AppLayoutProps) {
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [sidebarOpen, setSidebarOpen] = React.useState(false)
  const [titleItem, setTitleItem] = React.useState<PosterItem | null>(null)
  const location = useLocation()
  const navItems = isAdmin(session) ? [...NAV_ITEMS, ...ADMIN_NAV_ITEMS] : NAV_ITEMS

  // Close sidebar on route change
  React.useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !searchOpen && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [searchOpen])

  const initials = (session.user.name || session.user.email)
    .split(/[\s@]/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || "")
    .join("")

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 lg:h-16 lg:gap-6 lg:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="size-5" />
          </Button>

          <NavLink to="/" className="flex shrink-0 items-center gap-2">
            <img src="/findr-logo.svg" alt="Findr" className="size-6 lg:size-7" />
            <span className="text-base font-bold lg:text-lg" style={{ color: "oklch(0.77 0.165 70)" }}>
              Findr
            </span>
          </NavLink>

          <nav className="hidden h-14 items-center gap-6 md:flex lg:h-16 lg:gap-8">
            {navItems.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  cn(
                    "relative flex h-full items-center text-sm font-semibold transition-colors lg:text-base",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {label}
                    {isActive && (
                      <div className="absolute inset-x-0 bottom-0 h-0.5" style={{ backgroundColor: "oklch(0.77 0.165 70)" }} />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex flex-1 justify-center">
            <button
              onClick={() => setSearchOpen(true)}
              className="hidden w-full max-w-md items-center gap-2 rounded-lg border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted md:flex lg:max-w-lg"
            >
              <Search className="size-4 shrink-0" />
              <span className="flex-1 text-left">Search movies and TV shows...</span>
              <kbd className="rounded border bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground lg:text-xs">
                /
              </kbd>
            </button>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground transition-opacity hover:opacity-80 lg:size-9 lg:text-sm"
            >
              {initials}
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>
                {session.user.name || session.user.email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
                onClick={() => signOut()}
              >
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelectItem={(item) => setTitleItem(item)}
      />

      {titleItem && (
        <TitleDialog
          item={titleItem}
          onClose={() => setTitleItem(null)}
          onItemClick={(item) => setTitleItem(item)}
        />
      )}

      {/* Mobile sidebar */}
      <div
        className={cn(
          "fixed inset-0 z-50 md:hidden",
          sidebarOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity duration-200",
            sidebarOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setSidebarOpen(false)}
        />
        <nav
          className={cn(
            "absolute inset-y-0 left-0 w-64 bg-background shadow-xl transition-transform duration-200",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 items-center justify-between px-4">
            <NavLink to="/" className="flex items-center gap-2">
              <img src="/findr-logo.svg" alt="Findr" className="size-6" />
              <span className="text-base font-bold" style={{ color: "oklch(0.77 0.165 70)" }}>
                Findr
              </span>
            </NavLink>
            <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(false)}>
              <X className="size-5" />
            </Button>
          </div>
          <div className="border-t px-2 py-2">
            {navItems.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-0 border-t p-4">
            <button
              onClick={() => signOut()}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {initials}
              </span>
              Sign out
            </button>
          </div>
        </nav>
      </div>
    </div>
  )
}
