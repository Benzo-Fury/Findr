import * as React from "react"
import { Menu } from "@videojs/react"
import { CheckIcon } from "@videojs/react/icons"
import { Button } from "@/components/videojs/ui/button"
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip"
import { MenuChevron } from "@/components/videojs/ui/menu-chevron"
import { RadioItem } from "@/components/videojs/ui/radio-item"
import { cn } from "@/lib/resolve-class-name"

/**
 * Findr's own entries in the player's control bar, drawn like the Video.js
 * skin's: submenus for the settings menu whose choices Findr makes rather
 * than the player (quality and audio start a new session), a checkbox item,
 * a note line, and a menu of its own behind a control bar button. The class
 * names follow the skin's menus in `components/videojs/ui/`.
 */

/** A row in a menu, highlighted on hover and keyboard focus by the skin's sliding highlight. */
const ITEM_CLASS = cn(
  "relative flex cursor-pointer select-none items-center gap-1.5 rounded-media-menu-item px-2 py-1.5 text-start whitespace-nowrap",
  "focus-ring-media media-highlighted:highlight-media focus-visible:outline-media-ring focus-visible:outline-offset-2",
  "text-shadow-media transition-[background-color,color] duration-media-fast ease-in-out",
  "media-anchored:duration-media-instant media-anchored:media-highlighted:duration-media-slow",
  "justify-between tabular-nums text-inherit",
  "aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
  "media-anchored:data-highlighted:[anchor-name:--media-menu-item-highlight-anchor]",
  "media-anchored:media-highlighted:bg-transparent",
)

/** One page of a menu, sliding aside when a submenu opens over it. */
const CONTENT_CLASS = cn(
  "[anchor-scope:--media-menu-item-highlight-anchor]",
  "media-anchored:before:anchor-media-highlight media-transitioning:before:hidden media-transitioning:[&_*]:before:hidden",
  "media-anchored:has-data-[highlighted=]:before:duration-0",
  "not-data-submenu:flex not-data-submenu:flex-col not-data-submenu:gap-0.5",
  "not-data-submenu:data-child-open:blur-media-hidden not-data-submenu:data-child-open:before:hidden",
  "data-submenu:media-transitioning:pointer-events-none data-submenu:media-transitioning:overflow-hidden",
  "data-submenu:media-transitioning:blur-media-hidden",
  "absolute max-h-[inherit] overflow-auto overscroll-none outline-hidden",
  "transition-[translate,filter] duration-media-menu ease-out",
  "not-data-submenu:inset-x-1 not-data-submenu:top-1",
  "not-data-submenu:data-child-open:-translate-x-full not-data-submenu:data-child-open:rtl:translate-x-full",
  "data-submenu:inset-x-0 data-submenu:top-0 data-submenu:z-10 data-submenu:max-h-[inherit] data-submenu:p-1",
  "data-submenu:media-transitioning:translate-x-full data-submenu:media-transitioning:rtl:-translate-x-full",
)

/** The floating surface a control bar menu opens in. */
const POPUP_CLASS = cn(
  "m-0 overflow-visible border-0 text-inherit",
  "media-transitioning:opacity-0 media-transitioning:blur-media-hidden-popup media-transitioning:scale-media-hidden-popup",
  "data-starting-style:transform-[translate(var(--media-popup-translate-x-distance,0),var(--media-popup-translate-y-distance,0))]",
  "data-ending-style:transform-none",
  "data-[side=top]:origin-bottom data-[side=bottom]:origin-top",
  "data-[side=top]:[--media-popup-translate-y-distance:var(--media-popup-translate-distance)]",
  "data-[side=bottom]:[--media-popup-translate-y-distance:calc(var(--media-popup-translate-distance)*-1)]",
  "bg-media-popover text-media-popover-foreground surface-media after:surface-media-inset",
  "m-0 min-w-44 max-w-(--media-menu-available-width) overflow-hidden! rounded-media-popup border-0 p-1 [--media-popup-side-offset:var(--media-popover-side-offset)]",
  "max-h-[min(var(--media-menu-available-height,--spacing(56)),--spacing(56))] overscroll-none",
  "h-(--media-menu-height) w-(--media-menu-width)",
  "transition-media-popup media-transitioning:transition-media-popup transition-media-menu-resize",
)

/** A menu row's leading icon, muted until the row is highlighted. */
const ICON_CLASS = "size-media-icon shrink-0 drop-shadow-media-icon text-media-muted-foreground"

const SEPARATOR_CLASS = "my-1 block border-b border-media-border shadow-media-separator media-high-contrast:border-media-foreground/25"

/** An icon component, from Video.js's set or Phosphor's. */
type IconComponent = React.ComponentType<{ className?: string }>

export interface SubmenuOption {
  value: string
  label: React.ReactNode
  /** Trailing detail, such as a track's codec. */
  detail?: React.ReactNode
}

interface SubmenuProps {
  icon: IconComponent
  label: string
  options: SubmenuOption[]
  value: string
  onValueChange: (value: string) => void
}

/** A settings submenu of mutually exclusive choices, showing the current one beside its name. */
export function Submenu({ icon: Icon, label, options, value, onValueChange }: SubmenuProps) {
  const current = options.find((option) => option.value === value)
  return (
    <Menu.Root>
      <Menu.Trigger className={cn("group/menu-trigger-item", ITEM_CLASS)}>
        <Icon className={cn(ICON_CLASS, "group-media-highlighted/menu-trigger-item:text-inherit")} />
        <span>{label}</span>
        <span className="ms-auto inline-flex min-w-0 items-center gap-1 ps-2">
          <span className="max-w-24 truncate opacity-65">{current?.label}</span>
          <MenuChevron />
        </span>
      </Menu.Trigger>
      <Menu.Content className={CONTENT_CLASS}>
        <Menu.Item className={cn("group/menu-back-item mb-0.5 w-full", ITEM_CLASS, "justify-start")}>
          <MenuChevron back />
          <span>{label}</span>
        </Menu.Item>
        <Menu.Separator className={SEPARATOR_CLASS} />
        <Menu.RadioGroup value={value} onValueChange={onValueChange} className="flex flex-col gap-0.5">
          {options.map((option) => (
            <RadioItem key={option.value} value={option.value}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{option.label}</span>
                {option.detail && <span className="font-mono text-media-xs opacity-65">{option.detail}</span>}
              </span>
            </RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  )
}

interface CheckItemProps {
  icon: IconComponent
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: React.ReactNode
}

/** A menu row that turns something on or off, ticked while it is on. */
export function CheckItem({ icon: Icon, checked, onCheckedChange, children }: CheckItemProps) {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onCheckedChange} className={cn("group/menu-check-item", ITEM_CLASS)}>
      <Icon className={cn(ICON_CLASS, "group-media-highlighted/menu-check-item:text-inherit")} />
      <span className="me-auto">{children}</span>
      <CheckIcon className={cn(ICON_CLASS, "-me-1 group-media-highlighted/menu-check-item:text-inherit", !checked && "opacity-0")} />
    </Menu.CheckboxItem>
  )
}

/**
 * A line of small print at the foot of a menu. It takes the menu's width
 * rather than setting it, so a long note wraps instead of widening the menu.
 */
export function MenuNote({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Menu.Separator className={SEPARATOR_CLASS} />
      <p className="w-0 min-w-full whitespace-normal px-2 pb-1 pt-0.5 text-media-sm leading-snug text-media-muted-foreground">{children}</p>
    </>
  )
}

/** A heading over a group of menu rows. */
export function MenuLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 pb-0.5 pt-1 text-media-sm text-media-muted-foreground">
      {children}
      {action}
    </div>
  )
}

interface MenuRowProps {
  icon?: IconComponent
  onSelect: () => void
  disabled?: boolean
  children: React.ReactNode
}

/** A menu row that does something when picked. */
export function MenuRow({ icon: Icon, onSelect, disabled, children }: MenuRowProps) {
  return (
    <Menu.Item onSelect={onSelect} disabled={disabled} className={cn("group/menu-row", ITEM_CLASS, "justify-start")}>
      {Icon && <Icon className={cn(ICON_CLASS, "group-media-highlighted/menu-row:text-inherit")} />}
      {children}
    </Menu.Item>
  )
}

interface BarMenuProps {
  icon: IconComponent
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

/** A control bar button with a menu of its own, opening above it. */
export function BarMenu({ icon: Icon, label, open, onOpenChange, children }: BarMenuProps) {
  return (
    <Menu.Root side="top" align="end" open={open} onOpenChange={(next) => onOpenChange(next)}>
      <ButtonTooltip label={label} side="top">
        <Menu.Trigger render={<Button />} aria-label={label} className="group/bar-menu">
          <Icon className="col-start-1 row-start-1 size-media-icon drop-shadow-media-icon [text-shadow:inherit]" />
        </Menu.Trigger>
      </ButtonTooltip>
      <Menu.Popup className={POPUP_CLASS}>
        <Menu.Content className={CONTENT_CLASS}>{children}</Menu.Content>
      </Menu.Popup>
    </Menu.Root>
  )
}
