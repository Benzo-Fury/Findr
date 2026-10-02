import { NavLink } from "react-router-dom"
import { motion } from "motion/react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import type { Session } from "@/lib/auth"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Kbd } from "@/components/ui/kbd"
import { Brand } from "@/components/shell/brand"
import { CountBadge } from "@/components/shell/count-badge"
import { NAV_ITEMS } from "@/components/shell/nav-items"
import { UserMenu } from "@/components/shell/user-menu"

interface TopBarProps {
  session: Session
  activeCount: number
  onSearch: () => void
}

/**
 * The bar across the top. On tablets and desktops it carries the primary
 * navigation as a track with an amber marker that slides between pages; on
 * phones navigation moves to the tab bar and this keeps only the brand,
 * search and account.
 */
export function TopBar({ session, activeCount, onSearch }: TopBarProps) {
  return (
    <header className="sticky top-0 z-[var(--z-chrome)] h-[var(--chrome-height)] border-b border-line/70 bg-paper/82 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto grid h-full max-w-[1600px] grid-cols-[auto_1fr_auto] items-center gap-4 px-4 md:px-8">
        <NavLink to="/" aria-label="Findr, Library" className="rounded-full outline-offset-4">
          <Brand />
        </NavLink>

        <nav aria-label="Primary" className="hidden justify-center md:flex">
          <div className="flex items-center gap-1 rounded-full bg-sunken p-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "relative flex h-9 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors duration-200",
                    isActive ? "text-ink" : "text-ink-2 hover:text-ink",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span layoutId="nav-marker" transition={SPRING_SNAP} className="absolute inset-0 rounded-full bg-signal" />
                    )}
                    <span className="relative">{item.label}</span>
                    {item.badge === "active" && (
                      <CountBadge
                        count={activeCount}
                        label={`${activeCount} running`}
                        className={cn("relative", isActive && "bg-ink text-signal")}
                      />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="col-start-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search titles"
            className="flex h-10 items-center gap-2.5 rounded-full bg-surface px-3 text-sm text-ink-2 shadow-ring transition-[box-shadow,color,transform] duration-200 hover:text-ink hover:shadow-[0_0_0_1px_var(--color-line-strong)] active:scale-95 lg:w-60 lg:px-4"
          >
            <MagnifyingGlassIcon weight="bold" className="size-[1.125rem]" />
            <span className="hidden flex-1 text-left lg:inline">Search titles</span>
            <Kbd className="hidden lg:inline-flex">⌘K</Kbd>
          </button>
          <UserMenu session={session} />
        </div>
      </div>
    </header>
  )
}
