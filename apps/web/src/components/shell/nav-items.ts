import { BooksIcon, ChartBarIcon, CompassIcon, DownloadSimpleIcon, type Icon } from "@phosphor-icons/react"

/** A primary destination, shown in the top bar and the phone tab bar. */
export interface NavItem {
  to: string
  label: string
  icon: Icon
  /** Shows how many downloads are running. */
  badge?: "active"
  /** Only admins see it. */
  admin?: boolean
}

/** The primary pages, in order. Settings lives in the user menu. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Library", icon: BooksIcon },
  { to: "/discover", label: "Discover", icon: CompassIcon },
  { to: "/downloads", label: "Downloads", icon: DownloadSimpleIcon, badge: "active" },
  { to: "/admin", label: "Admin", icon: ChartBarIcon, admin: true },
]

/** The pages an account may open: every one for admins, the rest without Admin. */
export function navItemsFor(admin: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => admin || !item.admin)
}
