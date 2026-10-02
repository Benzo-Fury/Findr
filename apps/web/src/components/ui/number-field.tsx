import * as React from "react"
import { MinusIcon, PlusIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { INPUT_CLASS } from "@/components/ui/field"

interface NumberFieldProps {
  id?: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Shown after the number, such as "GB" or "min". */
  unit?: string
  invalid?: boolean
  "aria-describedby"?: string
}

/**
 * A number with step buttons either side. Typing is free; the value is
 * committed as a number, and the buttons respect the bounds.
 */
export function NumberField({ id, value, onChange, min, max, step = 1, unit, invalid, ...aria }: NumberFieldProps) {
  const [text, setText] = React.useState(String(value))

  // Follow outside changes (a save, a discard) unless the text already says the same
  React.useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)))
  }, [value])

  function commit(next: number) {
    const bounded = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next))
    const rounded = Math.round(bounded * 1000) / 1000
    setText(String(rounded))
    onChange(rounded)
  }

  return (
    <div className="flex items-center gap-1.5">
      <StepButton label="Decrease" disabled={min !== undefined && value <= min} onClick={() => commit(value - step)}>
        <MinusIcon weight="bold" className="size-3.5" />
      </StepButton>
      <div className="relative">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setText(event.target.value)
            const parsed = Number(event.target.value)
            if (event.target.value.trim() !== "" && Number.isFinite(parsed)) onChange(parsed)
          }}
          onBlur={() => commit(Number.isFinite(Number(text)) && text.trim() !== "" ? Number(text) : value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault()
              commit(value + step)
            }
            if (event.key === "ArrowDown") {
              event.preventDefault()
              commit(value - step)
            }
          }}
          className={cn(INPUT_CLASS, "w-28 text-center font-mono tabular", unit && "pr-10")}
          {...aria}
        />
        {unit && (
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-micro font-medium text-ink-3">{unit}</span>
        )}
      </div>
      <StepButton label="Increase" disabled={max !== undefined && value >= max} onClick={() => commit(value + step)}>
        <PlusIcon weight="bold" className="size-3.5" />
      </StepButton>
    </div>
  )
}

interface StepButtonProps {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}

function StepButton({ label, disabled, onClick, children }: StepButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-full text-ink-2 shadow-ring transition-[transform,background-color,color] hover:bg-sunken hover:text-ink active:scale-90 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
