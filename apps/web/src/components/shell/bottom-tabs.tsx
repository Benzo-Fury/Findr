import { NavLink } from "react-router-dom"
import { motion } from "motion/react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { CountBadge } from "@/components/shell/count-badge"
import { NAV_ITEMS } from "@/components/shell/nav-items"

interface BottomTabsProps {
  activeCount: number
  onSearch: () => void
}

const TAB_CLASS = "relative flex h-full flex-1 flex-col items-center justify-center gap-1 text-micro font-semibold"

/**
 * Phone navigation within thumb reach: the three pages plus search, each a
 * full-height target. The current tab's icon sits on an amber pill.
 */
export function BottomTabs({ activeCount, onSearch }: BottomTabsProps) {
  const [library, discover, downloads] = NAV_ITEMS

  return (
    <nav
      aria-label="Primary"
      className="pad-safe-bottom fixed inset-x-0 bottom-0 z-[var(--z-chrome)] border-t border-line/70 bg-paper/88 backdrop-blur-xl backdrop-saturate-150 md:hidden"
    >
      <div className="flex h-[var(--tabs-height)] items-stretch px-2">
        {[library, discover].map((item) => item && <Tab key={item.to} item={item} activeCount={activeCount} />)}
        <button type="button" onClick={onSearch} className={cn(TAB_CLASS, "text-ink-2 active:text-ink")}>
          <span className="flex h-8 w-14 items-center justify-center">
            <MagnifyingGlassIcon weight="bold" className="size-[1.375rem]" />
          </span>
          Search
        </button>
        {downloads && <Tab item={downloads} activeCount={activeCount} />}
      </div>
    </nav>
  )
}

interface TabProps {
  item: (typeof NAV_ITEMS)[number]
  activeCount: number
}

function Tab({ item, activeCount }: TabProps) {
  const TabIcon = item.icon
  return (
    <NavLink to={item.to} end={item.to === "/"} className={({ isActive }) => cn(TAB_CLASS, isActive ? "text-ink" : "text-ink-2")}>
      {({ isActive }) => (
        <>
          <span className="relative flex h-8 w-14 items-center justify-center">
            {isActive && <motion.span layoutId="tab-marker" transition={SPRING_SNAP} className="absolute inset-0 rounded-full bg-signal" />}
            <TabIcon weight={isActive ? "fill" : "bold"} className="relative size-[1.375rem]" />
            {item.badge === "active" && (
              <CountBadge count={activeCount} label={`${activeCount} running`} className="absolute -right-1 -top-1 bg-ink text-signal" />
            )}
          </span>
          {item.label}
        </>
      )}
    </NavLink>
  )
}
