import * as React from "react"
import { motion } from "motion/react"
import { ArrowsClockwiseIcon, CheckCircleIcon, MinusCircleIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react"
import type { AdminHealth, ServiceState } from "@findr/types/admin"
import { formatDuration } from "@/lib/format"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

const STATE_STYLE: Record<ServiceState, { icon: typeof CheckCircleIcon; className: string; label: string }> = {
  ok: { icon: CheckCircleIcon, className: "text-ok", label: "Healthy" },
  warn: { icon: WarningCircleIcon, className: "text-warn", label: "Worth a look" },
  bad: { icon: XCircleIcon, className: "text-bad", label: "Not working" },
  off: { icon: MinusCircleIcon, className: "text-ink-3", label: "Off" },
}

/** Problems first, then what's healthy, then what's turned off. */
const ORDER: Record<ServiceState, number> = { bad: 0, warn: 1, ok: 2, off: 3 }

/** Every dependency as a tile, problems first, then the server itself. */
export function SystemSection({ health }: { health: AdminHealth | null }) {
  if (!health) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-36 rounded-panel" />
        ))}
      </div>
    )
  }

  const services = [...health.services].sort((a, b) => ORDER[a.state] - ORDER[b.state])
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {services.map((service, index) => {
        const state = STATE_STYLE[service.state]
        return (
          <motion.div
            key={service.key}
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            whileHover={{ y: -2 }}
            transition={{ ...SPRING_SNAP, delay: index * 0.04 }}
            className={cn(
              "flex min-w-0 flex-col rounded-panel bg-surface p-5 shadow-ring",
              service.state === "bad" && "shadow-[0_0_0_1.5px_var(--color-bad)]",
              service.state === "off" && "bg-paper",
            )}
          >
            <p className="flex items-center justify-between gap-2 text-sm font-medium text-ink">
              {service.name}
              <span className={cn("inline-flex shrink-0 items-center gap-1 text-[0.8125rem]", state.className)}>
                <state.icon aria-hidden weight="fill" className="size-4" />
                {state.label}
              </span>
            </p>
            <p className={cn("display mt-4 truncate text-4xl", service.state === "off" ? "text-ink-3" : "text-ink")}>{service.value}</p>
            <p className="mt-1.5 text-[0.8125rem] leading-snug text-ink-2">{service.detail}</p>
          </motion.div>
        )
      })}
      <ServerTile server={health.server} />
    </div>
  )
}

/** The server's version and how long it has run, ticking every minute. */
function ServerTile({ server }: { server: AdminHealth["server"] }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const uptime = now - server.startedAt

  return (
    <div className="flex min-w-0 flex-col justify-between rounded-panel bg-ink p-5 text-surface">
      <p className="flex items-center justify-between gap-2 text-sm font-medium">
        Findr {server.version}
        <span className={cn("inline-flex items-center gap-1 text-[0.8125rem]", server.update ? "text-signal" : "text-surface/70")}>
          <ArrowsClockwiseIcon aria-hidden weight="bold" className="size-3.5" />
          {server.update ? `${server.update} ready` : "Up to date"}
        </span>
      </p>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[0.8125rem] text-surface/60">Running for</p>
          <p className="display mt-1 text-3xl text-signal">{uptime < 60_000 ? "Just started" : formatDuration(uptime)}</p>
        </div>
        <span className="font-mono text-[0.8125rem] text-surface/60">{server.platform}</span>
      </div>
    </div>
  )
}
