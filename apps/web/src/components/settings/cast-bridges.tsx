import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CheckIcon, CopyIcon, PlusIcon, TrashIcon, WifiHighIcon, WifiSlashIcon } from "@phosphor-icons/react"
import type { CastBridgeRecord, CreatedCastBridge } from "@findr/types/playback"
import { createCastBridge, deleteCastBridge, fetchCastBridges } from "@/lib/api"
import { formatRelativeTime } from "@/lib/format"
import { FADE, SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { TextInput } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"

/** How often the list refreshes while the page is open, to show bridges coming and going. */
const POLL_MS = 10_000

/**
 * Cast bridges, in the Playback settings section: Findr run as `findr bridge`
 * on another network, so DLNA TVs there show up for casting. Lists each with
 * whether it is connected, adds one (showing its command, with the token,
 * this once) and removes one. Changes apply at once, not through the save dock.
 */
export function CastBridgesPanel() {
  const toast = useToast()
  const [bridges, setBridges] = React.useState<CastBridgeRecord[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [adding, setAdding] = React.useState(false)
  const [created, setCreated] = React.useState<CreatedCastBridge | null>(null)

  const load = React.useCallback((signal?: AbortSignal) => {
    fetchCastBridges({ signal })
      .then((next) => {
        setBridges(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Could not load the bridges")
      })
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    const timer = window.setInterval(() => load(controller.signal), POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [load])

  async function add(event: React.FormEvent) {
    event.preventDefault()
    setAdding(true)
    try {
      const next = await createCastBridge({ name: name.trim() })
      setCreated(next)
      setName("")
      load()
    } catch (reason) {
      toast({ title: "Could not add the bridge", description: reason instanceof Error ? reason.message : undefined, tone: "bad" })
    } finally {
      setAdding(false)
    }
  }

  async function remove(bridge: CastBridgeRecord) {
    setBridges((current) => current?.filter((entry) => entry.id !== bridge.id) ?? null)
    if (created?.bridge.id === bridge.id) setCreated(null)
    try {
      await deleteCastBridge(bridge.id)
      toast({ title: "Bridge removed", description: bridge.name })
    } catch (reason) {
      toast({ title: "Could not remove the bridge", description: reason instanceof Error ? reason.message : undefined, tone: "bad" })
    }
    load()
  }

  return (
    <div className="rounded-panel bg-sunken px-4 py-3.5">
      <p className="text-micro font-semibold text-ink-3">TV bridges</p>
      <p className="mt-1 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-2">
        Chromecast and AirPlay TVs work from any network the browser is on. DLNA TVs are found by Findr itself, so for a network other than the server's, run a bridge on an always-on machine there.
      </p>

      {error ? (
        <p className="mt-3 text-[0.8125rem] text-bad">{error}</p>
      ) : bridges === null ? (
        <Skeleton className="mt-3 h-12 rounded-[0.75rem]" />
      ) : (
        bridges.length > 0 && (
          <ul className="mt-2 divide-y divide-line">
            <AnimatePresence initial={false}>
              {bridges.map((bridge) => (
                <motion.li key={bridge.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 24 }} transition={FADE}>
                  <BridgeRow bridge={bridge} onRemove={() => void remove(bridge)} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )
      )}

      <AnimatePresence initial={false}>
        {created && (
          <motion.div key={created.bridge.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={FADE}>
            <NewBridge created={created} onDone={() => setCreated(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      <form onSubmit={add} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor="cast-bridge-name" className="sr-only">
          Where the bridge is
        </label>
        <TextInput
          id="cast-bridge-name"
          value={name}
          maxLength={40}
          placeholder="Where it is, such as Home"
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          className="bg-surface sm:max-w-72"
          required
        />
        <Button type="submit" size="md" icon={PlusIcon} loading={adding} disabled={!name.trim()} className="shrink-0 self-start sm:self-auto">
          Add bridge
        </Button>
      </form>
    </div>
  )
}

/** One bridge: where it is, whether it is connected and how many TVs it found, and removing it. */
function BridgeRow({ bridge, onRemove }: { bridge: CastBridgeRecord; onRemove: () => void }) {
  const [confirming, setConfirming] = React.useState(false)
  const StateIcon = bridge.online ? WifiHighIcon : WifiSlashIcon
  const tvs = `${bridge.renderers} ${bridge.renderers === 1 ? "TV" : "TVs"}`
  const detail = bridge.online
    ? [`Connected`, tvs, bridge.version && `Findr ${bridge.version}`].filter(Boolean).join(", ")
    : bridge.lastSeenAt
      ? `Not connected, last seen ${formatRelativeTime(bridge.lastSeenAt)}`
      : "Never connected"

  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full bg-surface shadow-ring", bridge.online ? "text-ok" : "text-ink-3")}>
        <StateIcon aria-hidden weight="bold" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.875rem] font-semibold text-ink">{bridge.name}</p>
        <p className="mt-0.5 truncate text-micro text-ink-3">{detail}</p>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {confirming ? (
          <motion.span key="confirm" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={SPRING_SNAP} className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button variant="danger" size="sm" icon={TrashIcon} onClick={onRemove}>
              Remove
            </Button>
          </motion.span>
        ) : (
          <motion.span key="remove" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={SPRING_SNAP}>
            <Button variant="ghost" size="sm" iconOnly icon={TrashIcon} onClick={() => setConfirming(true)} aria-label={`Remove ${bridge.name}`} />
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}

/** The command that starts a bridge just added, with its token, shown this once. */
function NewBridge({ created, onDone }: { created: CreatedCastBridge; onDone: () => void }) {
  const [copied, setCopied] = React.useState(false)
  const command = `findr bridge --server ${window.location.origin} --token ${created.token}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard refused (an insecure origin); the command can still be selected by hand
    }
  }

  return (
    <div className="mt-3 rounded-[0.75rem] bg-surface p-3.5 shadow-ring">
      <p className="text-[0.8125rem] font-semibold text-ink">Run this on a machine on the {created.bridge.name} network</p>
      <p className="mt-0.5 text-micro text-ink-3">The token is shown only now. In Docker, add --network host so the bridge can find TVs.</p>
      <pre className="mt-2.5 overflow-x-auto rounded-[0.5rem] bg-sunken px-3 py-2.5 font-mono text-micro text-ink [overflow-wrap:anywhere] whitespace-pre-wrap">{command}</pre>
      <div className="mt-2.5 flex gap-1">
        <Button size="sm" icon={copied ? CheckIcon : CopyIcon} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
