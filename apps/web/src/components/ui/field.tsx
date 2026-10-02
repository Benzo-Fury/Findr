import * as React from "react"
import { cn } from "@/lib/utils"

/** The shared look of every text-like input: a pill well that brightens on focus. */
export const INPUT_CLASS = cn(
  "h-11 w-full min-w-0 rounded-full bg-sunken px-4 text-sm text-ink",
  "shadow-[inset_0_0_0_1px_transparent] transition-[background-color,box-shadow] duration-200",
  "hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
  "focus:bg-surface focus:shadow-[inset_0_0_0_1.5px_var(--color-ink)] focus:outline-none",
  "aria-invalid:shadow-[inset_0_0_0_1.5px_var(--color-bad)]",
  "disabled:cursor-not-allowed disabled:opacity-60",
)

interface FieldProps {
  label: React.ReactNode
  /** Explains the field; always rendered when given, below the label. */
  help?: React.ReactNode
  error?: string | null
  /** Receives the ids that tie the label, help and error to the control. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => React.ReactNode
  className?: string
}

/** Label above, control, then help and error below: one layout for every form. */
export function Field({ label, help, error, children, className }: FieldProps) {
  const id = React.useId()
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {help && (
        <p id={helpId} className="text-[0.8125rem] leading-relaxed text-ink-2">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[0.8125rem] font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  )
}

interface TextInputProps extends React.ComponentProps<"input"> {}

/** A text input in the shared style. */
export function TextInput({ className, ...props }: TextInputProps) {
  return <input className={cn(INPUT_CLASS, className)} {...props} />
}
