import { BooksIcon, CompassIcon, DownloadSimpleIcon, type Icon } from "@phosphor-icons/react"

/** A primary destination, shown in the top bar and the phone tab bar. */
export interface NavItem {
  to: string
  label: string
  icon: Icon
  /** Shows how many downloads are running. */
  badge?: "active"
}

/** The three primary pages, in order. Settings lives in the user menu. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Library", icon: BooksIcon },
  { to: "/discover", label: "Discover", icon: CompassIcon },
  { to: "/downloads", label: "Downloads", icon: DownloadSimpleIcon, badge: "active" },
]
