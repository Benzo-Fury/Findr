import { Switch as BaseSwitch } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  id?: string
  "aria-describedby"?: string
  "aria-label"?: string
  disabled?: boolean
}

/** An on/off toggle. The thumb springs across and the track fills amber when on. */
export function Switch({ checked, onChange, ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(value) => onChange(value)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200",
        "bg-line-strong data-[checked]:bg-signal",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        "disabled:opacity-50",
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "block size-6 rounded-full bg-surface shadow-[0_1px_3px_oklch(0.2_0.02_265/0.25)]",
          "transition-transform duration-300 ease-out-expo data-[checked]:translate-x-5",
        )}
      />
    </BaseSwitch.Root>
  )
}
