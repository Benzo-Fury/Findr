import { useNavigate } from "react-router-dom"
import { GearSixIcon, SignOutIcon } from "@phosphor-icons/react"
import { isAdmin, signOut, type Session } from "@/lib/auth"
import { Menu, MenuItem, MenuLink, MenuSeparator } from "@/components/ui/menu"

interface UserMenuProps {
  session: Session
}

/** Up to two initials from the user's name, or from their email. */
function initials(session: Session): string {
  const source = session.user.name || session.user.email
  return source
    .split(/[\s@._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

/** The account corner: who is signed in, Settings for admins, and sign-out. */
export function UserMenu({ session }: UserMenuProps) {
  const navigate = useNavigate()

  return (
    <Menu
      trigger={
        <button
          type="button"
          aria-label="Account menu"
          className="flex size-10 items-center justify-center rounded-full bg-ink font-display text-sm font-semibold text-surface transition-[transform,box-shadow] duration-200 hover:shadow-[0_0_0_3px_var(--color-signal)] active:scale-90 data-[popup-open]:shadow-[0_0_0_3px_var(--color-signal)]"
        >
          {initials(session)}
        </button>
      }
    >
      <div className="px-3 pb-2 pt-1.5">
        <p className="truncate text-sm font-semibold text-ink">{session.user.name || "Signed in"}</p>
        <p className="truncate text-[0.8125rem] text-ink-2">{session.user.email}</p>
      </div>
      <MenuSeparator />
      {isAdmin(session) && (
        <MenuLink icon={GearSixIcon} href="/settings" onNavigate={navigate}>
          Settings
        </MenuLink>
      )}
      <MenuItem icon={SignOutIcon} onClick={() => signOut()}>
        Sign out
      </MenuItem>
    </Menu>
  )
}
