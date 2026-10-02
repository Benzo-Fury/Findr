import * as React from "react"
import { Menu as BaseMenu } from "@base-ui/react/menu"
import { AnimatePresence, motion } from "motion/react"
import type { Icon } from "@phosphor-icons/react"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface MenuProps {
  /** The element that opens the menu; rendered as the trigger. */
  trigger: React.ReactElement<Record<string, unknown>>
  children: React.ReactNode
  align?: "start" | "end"
  className?: string
}

/**
 * A dropdown menu: keyboard navigable, typeahead searchable, and closed by
 * Escape or an outside click. It scales out of its trigger's corner.
 */
export function Menu({ trigger, children, align = "end", className }: MenuProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <BaseMenu.Root open={open} onOpenChange={setOpen}>
      <BaseMenu.Trigger render={trigger} />
      <AnimatePresence>
        {open && (
          <BaseMenu.Portal keepMounted>
            <BaseMenu.Positioner sideOffset={8} align={align} className="z-[var(--z-overlay)] outline-none">
              <BaseMenu.Popup
                render={
                  <motion.div
                    initial={{ opacity: 0, scale: 0.94, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: -2 }}
                    transition={SPRING_SNAP}
                  />
                }
                className={cn(
                  "min-w-56 origin-[var(--transform-origin)] rounded-panel bg-surface p-1.5 shadow-float outline-none ring-1 ring-line",
                  className,
                )}
              >
                {children}
              </BaseMenu.Popup>
            </BaseMenu.Positioner>
          </BaseMenu.Portal>
        )}
      </AnimatePresence>
    </BaseMenu.Root>
  )
}

const ITEM_CLASS =
  "flex h-10 w-full cursor-pointer select-none items-center gap-2.5 rounded-[0.75rem] px-3 text-sm font-medium text-ink outline-none transition-colors data-[highlighted]:bg-sunken"

interface MenuItemProps {
  icon?: Icon
  onClick?: () => void
  tone?: "default" | "danger"
  disabled?: boolean
  children: React.ReactNode
}

/** One action in a menu. */
export function MenuItem({ icon: ItemIcon, onClick, tone = "default", disabled, children }: MenuItemProps) {
  return (
    <BaseMenu.Item
      onClick={onClick}
      disabled={disabled}
      className={cn(ITEM_CLASS, tone === "danger" && "text-bad data-[highlighted]:bg-bad-soft", disabled && "opacity-50")}
    >
      {ItemIcon && <ItemIcon aria-hidden weight="bold" className="size-4 shrink-0" />}
      {children}
    </BaseMenu.Item>
  )
}

interface MenuLinkProps {
  icon?: Icon
  href: string
  /** Client-side navigation; the browser default is prevented. */
  onNavigate: (href: string) => void
  children: React.ReactNode
}

/** A menu entry that goes somewhere, keeping the link's semantics. */
export function MenuLink({ icon: ItemIcon, href, onNavigate, children }: MenuLinkProps) {
  return (
    <BaseMenu.LinkItem
      href={href}
      onClick={(event) => {
        event.preventDefault()
        onNavigate(href)
      }}
      className={ITEM_CLASS}
    >
      {ItemIcon && <ItemIcon aria-hidden weight="bold" className="size-4 shrink-0" />}
      {children}
    </BaseMenu.LinkItem>
  )
}

/** A hairline between groups of menu items. */
export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-2 my-1.5 h-px bg-line" />
}
