import * as React from "react"
import { Check, Loader2, Trash2 } from "lucide-react"
import { ReleaseTypeSchema, ResolutionSchema } from "@findr/types/media"
import { SECRET_FIELDS, type SecretField, type Settings, type SettingsPatch, type SettingsResponse, type SettingsSection } from "@findr/types/settings"
import { fetchSettings, updateSettings } from "@/lib/api"
import { authClient, useSession } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Admin settings: everything tunable about how Findr searches, downloads and
 * saves, stored on the server and applied to the next download without a
 * restart — plus account management, since there is no public sign-up.
 * Each section saves on its own.
 *
 * API keys are write-only here: the server never sends them back, only
 * whether each is set. Typing a key replaces it; leaving it blank keeps it.
 */

export function SettingsPage() {
  const [server, setServer] = React.useState<SettingsResponse | null>(null)
  const [draft, setDraft] = React.useState<Settings | null>(null)
  const [saving, setSaving] = React.useState<SettingsSection | null>(null)
  const [saved, setSaved] = React.useState<SettingsSection | null>(null)
  const [error, setError] = React.useState<{ section: SettingsSection; message: string } | null>(null)

  React.useEffect(() => {
    fetchSettings()
      .then((response) => {
        setServer(response)
        setDraft(response.settings)
      })
      .catch(() => {})
  }, [])

  /** Replaces one field of one section in the draft. */
  function edit<K extends SettingsSection, F extends keyof Settings[K]>(section: K, field: F, value: Settings[K][F]) {
    setDraft((current) => (current ? { ...current, [section]: { ...current[section], [field]: value } } : current))
    setSaved(null)
  }

  /** Saves one section and adopts what the server stored. */
  async function save(section: SettingsSection, patch?: SettingsPatch) {
    if (!draft) return
    setSaving(section)
    setError(null)
    try {
      const response = await updateSettings(patch ?? (section === "services" ? servicesPatch(draft) : pick(draft, section)))
      setServer(response)
      setDraft(response.settings)
      setSaved(section)
    } catch (e) {
      setError({ section, message: e instanceof Error ? e.message : "Could not save" })
    } finally {
      setSaving(null)
    }
  }

  if (!draft || !server) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 lg:py-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
    )
  }

  /** Removes a stored API key. */
  function clearSecret(field: SecretField) {
    save("services", { services: { [field]: "" } })
  }

  /** Shared props for each section's save footer. */
  const footer = (section: SettingsSection) => ({
    section,
    saving: saving === section,
    saved: saved === section,
    error: error?.section === section ? error.message : null,
    onSave: () => save(section),
  })

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 lg:py-8">
      <Section title="Services" description="The services Findr searches and looks titles up with. Keys are stored on the server and never shown again." footer={footer("services")}>
        <TextField label="Prowlarr URL" value={draft.services.prowlarrUrl} placeholder="http://localhost:9696" onChange={(value) => edit("services", "prowlarrUrl", value)} />
        <SecretField label="Prowlarr API key" value={draft.services.prowlarrApiKey} configured={server.configured.prowlarrApiKey} onChange={(value) => edit("services", "prowlarrApiKey", value)} onClear={() => clearSecret("prowlarrApiKey")} />
        <SecretField label="TMDB API key" value={draft.services.tmdbApiKey} configured={server.configured.tmdbApiKey} onChange={(value) => edit("services", "tmdbApiKey", value)} onClear={() => clearSecret("tmdbApiKey")} />
        <SecretField label="Anthropic API key (optional, for the wrong-title filter)" value={draft.services.anthropicApiKey} configured={server.configured.anthropicApiKey} onChange={(value) => edit("services", "anthropicApiKey", value)} onClear={() => clearSecret("anthropicApiKey")} />
      </Section>

      <Section title="Library paths" description="Absolute paths on the server. Downloads are staged in the first and moved into the others when finished." footer={footer("paths")}>
        <TextField label="Downloads (scratch space)" value={draft.paths.downloads} placeholder="/srv/findr/downloads" onChange={(value) => edit("paths", "downloads", value)} />
        <TextField label="Movies library" value={draft.paths.movies} placeholder="/srv/media/movies" onChange={(value) => edit("paths", "movies", value)} />
        <TextField label="TV library" value={draft.paths.series} placeholder="/srv/media/tv" onChange={(value) => edit("paths", "series", value)} />
      </Section>

      <Section title="Naming" description="Tokens: {title}, {year}, {season}, {episode}. Files always end in .mkv." footer={footer("naming")}>
        <TextField label="Movie folder" value={draft.naming.movieFolder} onChange={(value) => edit("naming", "movieFolder", value)} />
        <TextField label="Movie file" value={draft.naming.movieFile} onChange={(value) => edit("naming", "movieFile", value)} />
        <TextField label="Show folder" value={draft.naming.seriesFolder} onChange={(value) => edit("naming", "seriesFolder", value)} />
        <TextField label="Season folder" value={draft.naming.seasonFolder} onChange={(value) => edit("naming", "seasonFolder", value)} />
        <TextField label="Episode file" value={draft.naming.seriesFile} onChange={(value) => edit("naming", "seriesFile", value)} />
      </Section>

      <Section title="Release preferences" description="How releases are filtered and ranked." footer={footer("preferences")}>
        <ChipPicker
          label="Resolutions, in order of preference"
          options={ResolutionSchema.options}
          selected={draft.preferences.resolutions}
          ordered
          onChange={(value) => edit("preferences", "resolutions", value)}
        />
        <ChipPicker
          label="Never download"
          options={ReleaseTypeSchema.options}
          selected={draft.preferences.blacklistedReleaseTypes}
          onChange={(value) => edit("preferences", "blacklistedReleaseTypes", value)}
        />
        <NumberField label="Largest file per movie or episode (GB)" value={draft.preferences.maxFileSizeGB} onChange={(value) => edit("preferences", "maxFileSizeGB", value)} />
        <NumberField label="Minimum seeders" value={draft.preferences.minSeeders} onChange={(value) => edit("preferences", "minSeeders", value)} />
      </Section>

      <Section title="Scoring weights" description="How much each quality signal counts when ranking releases that passed the filters. Each weight is the most that signal can add." footer={footer("scoring")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Resolution" value={draft.scoring.resolution} onChange={(value) => edit("scoring", "resolution", value)} />
          <NumberField label="File size" value={draft.scoring.fileSize} onChange={(value) => edit("scoring", "fileSize", value)} />
          <NumberField label="Seeders" value={draft.scoring.seeders} onChange={(value) => edit("scoring", "seeders", value)} />
          <NumberField label="Codec" value={draft.scoring.codec} onChange={(value) => edit("scoring", "codec", value)} />
          <NumberField label="Release type" value={draft.scoring.releaseType} onChange={(value) => edit("scoring", "releaseType", value)} />
          <NumberField label="Release group" value={draft.scoring.releaseGroup} onChange={(value) => edit("scoring", "releaseGroup", value)} />
          <NumberField label="Upload recency" value={draft.scoring.uploadDate} onChange={(value) => edit("scoring", "uploadDate", value)} />
          <NumberField label="Repack bonus" value={draft.scoring.repack} onChange={(value) => edit("scoring", "repack", value)} />
          <NumberField label="Ideal size per movie (GB)" value={draft.scoring.idealMovieSizeGB} onChange={(value) => edit("scoring", "idealMovieSizeGB", value)} />
          <NumberField label="Ideal size per episode (GB)" value={draft.scoring.idealEpisodeSizeGB} onChange={(value) => edit("scoring", "idealEpisodeSizeGB", value)} />
          <NumberField label="Seeders beyond which score stops rising" value={draft.scoring.seederCap} onChange={(value) => edit("scoring", "seederCap", value)} />
          <NumberField label="Oversized 4K penalty" value={draft.scoring.bloated4KPenalty} onChange={(value) => edit("scoring", "bloated4KPenalty", value)} />
          <NumberField label="4K counts as oversized above (GB per movie or episode)" value={draft.scoring.bloated4KSizeGB} onChange={(value) => edit("scoring", "bloated4KSizeGB", value)} />
        </div>
      </Section>

      <Section title="Queue" description="How many downloads run at once, and how many releases each tries before giving up." footer={footer("queue")}>
        <NumberField label="Downloads running at once" value={draft.queue.maxConcurrent} onChange={(value) => edit("queue", "maxConcurrent", value)} />
        <NumberField label="Failed attempts before giving up (per movie, pack or episode)" value={draft.queue.maxAttempts} onChange={(value) => edit("queue", "maxAttempts", value)} />
      </Section>

      <Section title="Download watchdog" description="Abandon a release for the next one when it is not going to finish." footer={footer("watchdog")}>
        <NumberField label="Give up waiting for the file list after (minutes)" value={draft.watchdog.metadataTimeoutMinutes} onChange={(value) => edit("watchdog", "metadataTimeoutMinutes", value)} />
        <NumberField label="Give up when no data arrives for (minutes)" value={draft.watchdog.stallTimeoutMinutes} onChange={(value) => edit("watchdog", "stallTimeoutMinutes", value)} />
        <NumberField label="Minimum average speed (KB/s, 0 to disable)" value={draft.watchdog.minSpeedKBps} onChange={(value) => edit("watchdog", "minSpeedKBps", value)} />
        <NumberField label="Measure average speed over (minutes)" value={draft.watchdog.speedWindowMinutes} onChange={(value) => edit("watchdog", "speedWindowMinutes", value)} />
        <NumberField label="Check progress every (seconds)" value={draft.watchdog.pollIntervalSeconds} onChange={(value) => edit("watchdog", "pollIntervalSeconds", value)} />
      </Section>

      <Section
        title="Wrong-title filter"
        description="Uses Claude to drop releases that are clearly for a different title before anything downloads. Falls back to no filtering on any error."
        badge={server.configured.anthropicApiKey ? undefined : "No Anthropic API key set under Services"}
        footer={footer("llmFilter")}
      >
        <Toggle label="Enabled" checked={draft.llmFilter.enabled} onChange={(value) => edit("llmFilter", "enabled", value)} />
        <TextField label="Model" value={draft.llmFilter.model} onChange={(value) => edit("llmFilter", "model", value)} />
        <NumberField label="Releases to screen" value={draft.llmFilter.maxCandidates} onChange={(value) => edit("llmFilter", "maxCandidates", value)} />
        <NumberField label="Timeout (seconds)" value={draft.llmFilter.timeoutSeconds} onChange={(value) => edit("llmFilter", "timeoutSeconds", value)} />
      </Section>

      <Section title="Torrent client" description="The built-in BitTorrent client. Forward the port on your router for better speeds. Changes apply after Findr restarts." footer={footer("torrent")}>
        <NumberField label="Port (TCP for peers, UDP for the DHT; 0 picks a random port)" value={draft.torrent.port} onChange={(value) => edit("torrent", "port", value)} />
      </Section>

      <Section title="Access" description="Findr only answers requests from this machine unless remote access is on. Behind a reverse proxy on the same machine, also set TRUST_PROXY on the server." footer={footer("access")}>
        <Toggle label="Allow access from other machines" checked={draft.access.allowRemote} onChange={(value) => edit("access", "allowRemote", value)} />
      </Section>

      <UsersSection />
    </div>
  )
}

/** The services section as a patch: the URL, plus only the keys that were typed, so blank keys stay as they are. */
function servicesPatch(settings: Settings): SettingsPatch {
  const services: NonNullable<SettingsPatch["services"]> = { prowlarrUrl: settings.services.prowlarrUrl }
  for (const field of SECRET_FIELDS) {
    if (settings.services[field] !== "") services[field] = settings.services[field]
  }
  return { services }
}

/** One section of settings as a patch, typed to that section. */
function pick<K extends SettingsSection>(settings: Settings, section: K): Pick<Settings, K> {
  return { [section]: settings[section] } as Pick<Settings, K>
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface FooterProps {
  section: SettingsSection
  saving: boolean
  saved: boolean
  error: string | null
  onSave: () => void
}

interface SectionProps {
  title: string
  description: string
  badge?: string
  footer?: FooterProps
  children: React.ReactNode
}

function Section({ title, description, badge, footer, children }: SectionProps) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          {badge && <Badge variant="warning">{badge}</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
      {footer && (
        <div className="mt-5 flex items-center gap-3">
          <Button onClick={footer.onSave} disabled={footer.saving} className="gap-2">
            {footer.saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
          {footer.saved && (
            <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="size-4" /> Saved
            </span>
          )}
          {footer.error && <span className="text-sm text-destructive">{footer.error}</span>}
        </div>
      )}
    </section>
  )
}

interface TextFieldProps {
  label: string
  value: string
  placeholder?: string
  type?: "text" | "email" | "password"
  onChange: (value: string) => void
}

function TextField({ label, value, placeholder, type = "text", onChange }: TextFieldProps) {
  const id = React.useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

interface SecretFieldProps {
  label: string
  value: string
  /** Whether the server already holds a value for this key. */
  configured: boolean
  onChange: (value: string) => void
  onClear: () => void
}

/** A write-only key: shows whether one is stored, takes a replacement, and can remove it. */
function SecretField({ label, value, configured, onChange, onClear }: SecretFieldProps) {
  const id = React.useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="password" autoComplete="off" value={value} placeholder={configured ? "Saved; type to replace" : "Not set"} onChange={(e) => onChange(e.target.value)} />
        {configured && (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}

interface NumberFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
}

function NumberField({ label, value, onChange }: NumberFieldProps) {
  const id = React.useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={0} step="any" value={value} className="max-w-40" onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

interface ToggleProps {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <Label className="cursor-pointer">
      <input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </Label>
  )
}

interface ChipPickerProps<T extends string> {
  label: string
  options: readonly T[]
  selected: T[]
  /** When true, selection order is kept and shown as a rank. */
  ordered?: boolean
  onChange: (value: T[]) => void
}

/** Toggleable chips; ordered pickers append in click order and show each chip's rank. */
function ChipPicker<T extends string>({ label, options, selected, ordered, onChange }: ChipPickerProps<T>) {
  function toggle(option: T) {
    onChange(selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option])
  }

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const rank = selected.indexOf(option)
          const active = rank !== -1
          return (
            <button
              key={option}
              type="button"
              onClick={() => toggle(option)}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {ordered && active && <span className="mr-1 tabular-nums">{rank + 1}.</span>}
              {option}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The fields of a BetterAuth user this page shows. */
interface AccountRow {
  id: string
  name: string
  email: string
  role?: string | null
}

/** Account management through BetterAuth's admin plugin — the only way accounts are created. */
function UsersSection() {
  const { data: session } = useSession()
  const [users, setUsers] = React.useState<AccountRow[]>([])
  const [form, setForm] = React.useState({ name: "", email: "", password: "", role: "user" as "user" | "admin" })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const { data } = await authClient.admin.listUsers({ query: { limit: 100 } })
    setUsers(data?.users ?? [])
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.admin.createUser(form)
    if (failure) setError(failure.message ?? "Could not create the account")
    else {
      setForm({ name: "", email: "", password: "", role: "user" })
      await load()
    }
    setBusy(false)
  }

  async function remove(userId: string) {
    const { error: failure } = await authClient.admin.removeUser({ userId })
    if (failure) setError(failure.message ?? "Could not remove the account")
    await load()
  }

  return (
    <Section title="Accounts" description="Sign-up is disabled. Create an account here for anyone who should have access.">
      <ul className="divide-y rounded-lg border">
        {users.map((user) => (
          <li key={user.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
            {user.role === "admin" && <Badge variant="info">Admin</Badge>}
            {user.id !== session?.user.id && (
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => remove(user.id)} aria-label={`Remove ${user.email}`}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
        <TextField label="Email" type="email" value={form.email} onChange={(email) => setForm({ ...form, email })} />
        <TextField label="Password" type="password" value={form.password} onChange={(password) => setForm({ ...form, password })} />
        <div className="grid gap-1.5">
          <Label htmlFor="new-user-role">Role</Label>
          <select
            id="new-user-role"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value === "admin" ? "admin" : "user" })}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={busy || !form.email || !form.password || !form.name} className="gap-2">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create account
          </Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      </form>
    </Section>
  )
}
