import * as React from "react"
import { ProhibitIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { Field, INPUT_CLASS } from "@/components/ui/field"
import { Highlight } from "@/components/ui/highlight"
import { NumberField } from "@/components/ui/number-field"
import { Switch } from "@/components/ui/switch"
import { ResolutionOrder } from "@/components/settings/resolution-order"
import type { FieldDef } from "@/components/settings/registry"

interface FieldRowProps {
  field: FieldDef
  value: unknown
  onChange: (value: unknown) => void
  error?: string | null
  /** Search words to mark in the label. */
  words: string[]
  /** For secrets: whether the server holds a value. */
  configured?: boolean
  onClearSecret?: () => void
  onFocusField?: (key: string | null) => void
}

/**
 * One setting: label and explanation on the left, its control on the right
 * on wide screens, stacked on phones. The control is chosen by the field's
 * definition.
 */
export function FieldRow({ field, value, onChange, error, words, configured, onClearSecret, onFocusField }: FieldRowProps) {
  const control = field.control
  const wide = control.kind === "order" || control.kind === "multi"

  return (
    <div
      onFocus={() => onFocusField?.(field.key)}
      onBlur={() => onFocusField?.(null)}
      onPointerEnter={() => onFocusField?.(field.key)}
      onPointerLeave={() => onFocusField?.(null)}
      className={cn("grid gap-2 py-4 md:gap-x-8 md:gap-y-1", !wide && "md:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] md:items-center")}
    >
      <Field
        label={<Highlight text={field.label} words={words} />}
        help={field.help}
        error={error}
        className="contents [&>label]:md:col-start-1 [&>p]:md:col-start-1"
      >
        {({ id, describedBy, invalid }) => (
          <div className={cn(!wide && "md:col-start-2 md:row-span-3 md:row-start-1 md:flex md:justify-end")}>
            {control.kind === "text" && (
              <input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={String(value ?? "")}
                placeholder={control.placeholder}
                spellCheck={false}
                onChange={(event) => onChange(event.target.value)}
                className={cn(INPUT_CLASS, control.mono && "font-mono text-[0.8125rem]")}
              />
            )}
            {control.kind === "secret" && (
              <SecretInput id={id} describedBy={describedBy} value={String(value ?? "")} configured={configured ?? false} onChange={onChange} onClear={onClearSecret} />
            )}
            {control.kind === "number" && (
              <NumberField
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={Number(value ?? 0)}
                min={control.min}
                max={control.max}
                step={control.step}
                unit={control.unit}
                onChange={onChange}
              />
            )}
            {control.kind === "toggle" && <Switch id={id} aria-describedby={describedBy} checked={Boolean(value)} onChange={onChange} />}
            {control.kind === "order" && <ResolutionOrder options={control.options} value={value as string[]} onChange={onChange} />}
            {control.kind === "multi" && <MultiToggle options={control.options} value={value as string[]} onChange={onChange} />}
          </div>
        )}
      </Field>
    </div>
  )
}

interface SecretInputProps {
  id: string
  describedBy: string | undefined
  value: string
  configured: boolean
  onChange: (value: unknown) => void
  onClear?: () => void
}

/** A write-only key: says whether one is stored, takes a replacement, and can remove it. */
function SecretInput({ id, describedBy, value, configured, onChange, onClear }: SecretInputProps) {
  return (
    <div className="flex w-full items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <input
          id={id}
          type="password"
          autoComplete="off"
          aria-describedby={describedBy}
          value={value}
          placeholder={configured ? "Type to replace" : "Not set"}
          onChange={(event) => onChange(event.target.value)}
          className={cn(INPUT_CLASS, "pr-20 font-mono")}
        />
        <span
          className={cn(
            "pointer-events-none absolute right-2 top-1/2 inline-flex h-6 -translate-y-1/2 items-center rounded-full px-2 text-micro font-semibold",
            value ? "bg-signal text-ink" : configured ? "bg-ok-soft text-ok" : "bg-sunken text-ink-3",
          )}
        >
          {value ? "New" : configured ? "Saved" : "Empty"}
        </span>
      </div>
      {configured && onClear && (
        <button type="button" onClick={onClear} className="h-9 shrink-0 rounded-full px-3 text-[0.8125rem] font-medium text-bad transition-colors hover:bg-bad-soft">
          Remove
        </button>
      )}
    </div>
  )
}

interface MultiToggleProps {
  options: readonly string[]
  value: string[]
  onChange: (value: unknown) => void
}

/** A set of options, each switched on or off; on means blocked. */
function MultiToggle({ options, value, onChange }: MultiToggleProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const on = value.includes(option)
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((item) => item !== option) : [...value, option])}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 font-mono text-[0.8125rem] font-semibold transition-[background-color,color,box-shadow,transform] duration-200 active:scale-95",
              on ? "bg-ink text-surface" : "bg-surface text-ink-2 shadow-ring hover:text-ink",
            )}
          >
            {on && <ProhibitIcon aria-hidden weight="bold" className="size-3.5 text-signal" />}
            {option}
          </button>
        )
      })}
    </div>
  )
}
