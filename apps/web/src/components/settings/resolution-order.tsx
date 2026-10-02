import type * as React from "react"
import { Reorder, useDragControls } from "motion/react"
import { CaretDownIcon, CaretUpIcon, DotsSixVerticalIcon, PlusIcon, XIcon } from "@phosphor-icons/react"
import { SPRING_SNAP } from "@/lib/motion"

interface ResolutionOrderProps {
  options: readonly string[]
  value: string[]
  onChange: (value: string[]) => void
}

/**
 * An ordered preference list. Chosen entries can be dragged by their handle
 * or moved with buttons (so the keyboard works too); the rest wait below to
 * be added.
 */
export function ResolutionOrder({ options, value, onChange }: ResolutionOrderProps) {
  const unused = options.filter((option) => !value.includes(option))

  function move(index: number, step: -1 | 1) {
    const next = [...value]
    const [item] = next.splice(index, 1)
    if (item === undefined) return
    next.splice(index + step, 0, item)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <Reorder.Group axis="y" values={value} onReorder={onChange} className="flex flex-col gap-1.5">
        {value.map((option, index) => (
          <Row
            key={option}
            option={option}
            rank={index + 1}
            first={index === 0}
            last={index === value.length - 1}
            onUp={() => move(index, -1)}
            onDown={() => move(index, 1)}
            onRemove={() => onChange(value.filter((item) => item !== option))}
          />
        ))}
      </Reorder.Group>
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unused.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange([...value, option])}
              className="inline-flex h-8 items-center gap-1 rounded-full px-3 font-mono text-[0.8125rem] font-semibold text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)] [border-style:dashed] transition-colors hover:bg-sunken hover:text-ink active:scale-95"
            >
              <PlusIcon aria-hidden weight="bold" className="size-3" />
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface RowProps {
  option: string
  rank: number
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}

function Row({ option, rank, first, last, onUp, onDown, onRemove }: RowProps) {
  const drag = useDragControls()

  return (
    <Reorder.Item
      value={option}
      dragListener={false}
      dragControls={drag}
      transition={SPRING_SNAP}
      whileDrag={{ scale: 1.03, boxShadow: "var(--shadow-lift)" }}
      className="flex h-11 items-center gap-2 rounded-full bg-surface pl-1.5 pr-1.5 shadow-ring"
    >
      <span
        onPointerDown={(event) => drag.start(event)}
        aria-hidden
        className="flex size-8 cursor-grab touch-none items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink active:cursor-grabbing"
      >
        <DotsSixVerticalIcon weight="bold" className="size-4" />
      </span>
      <span className="flex size-6 items-center justify-center rounded-full bg-signal font-mono text-micro font-bold text-ink tabular">{rank}</span>
      <span className="flex-1 font-mono text-sm font-semibold text-ink">{option}</span>
      <IconAction label={`Move ${option} up`} disabled={first} onClick={onUp}>
        <CaretUpIcon weight="bold" className="size-3.5" />
      </IconAction>
      <IconAction label={`Move ${option} down`} disabled={last} onClick={onDown}>
        <CaretDownIcon weight="bold" className="size-3.5" />
      </IconAction>
      <IconAction label={`Remove ${option}`} onClick={onRemove}>
        <XIcon weight="bold" className="size-3.5" />
      </IconAction>
    </Reorder.Item>
  )
}

interface IconActionProps {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

function IconAction({ label, disabled, onClick, children }: IconActionProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-full text-ink-2 transition-[background-color,color,transform] hover:bg-sunken hover:text-ink active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
