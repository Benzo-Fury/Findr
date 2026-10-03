import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { MagnifyingGlassIcon, WarningIcon } from "@phosphor-icons/react"
import {
  SECRET_FIELDS,
  SettingsSchema,
  type SecretField,
  type Settings,
  type SettingsPatch,
  type SettingsResponse,
  type SettingsSection,
} from "@findr/types/settings"
import { fetchSettings, updateSettings } from "@/lib/api"
import { EASE_OUT, FADE, SPRING_SNAP } from "@/lib/motion"
import { matchesAll, queryWords } from "@/lib/search"
import { cn } from "@/lib/utils"
import { Accounts } from "@/components/settings/accounts"
import { FieldRow } from "@/components/settings/field-row"
import { FIELDS, SECTIONS, WEIGHT_KEYS, type FieldDef, type SectionDef } from "@/components/settings/registry"
import { SaveDock } from "@/components/settings/save-dock"
import { VpnStatusPanel } from "@/components/settings/vpn-status"
import { WeightBar } from "@/components/settings/weight-bar"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { PageHeader } from "@/components/ui/page-header"
import { SearchField } from "@/components/ui/search-field"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"

/**
 * Everything tunable about how Findr searches, downloads and saves. Search
 * narrows every section at once; edits anywhere collect in one save dock and
 * are checked against the same schemas the server uses before they are sent.
 * API keys are write-only: the server only says whether each one is set.
 */

/** The text a field can be found by. */
function searchText(field: FieldDef, section: SectionDef): string {
  return [field.label, field.help, field.keywords, section.title, section.keywords].filter(Boolean).join(" ")
}

/** The services section as a patch: the URL, plus only keys that were typed, so blank keys stay. */
function servicesPatch(settings: Settings): NonNullable<SettingsPatch["services"]> {
  const services: NonNullable<SettingsPatch["services"]> = { prowlarrUrl: settings.services.prowlarrUrl }
  for (const field of SECRET_FIELDS) {
    if (settings.services[field] !== "") services[field] = settings.services[field]
  }
  return services
}

/** Field errors for one section, keyed by field, from the shared schema. */
function sectionErrors(section: SettingsSection, value: unknown): Record<string, string> {
  const result = SettingsSchema.shape[section].safeParse(value)
  if (result.success) return {}
  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "")
    errors[key] ??= issue.message
  }
  return errors
}

export function SettingsPage() {
  const toast = useToast()
  const [server, setServer] = React.useState<SettingsResponse | null>(null)
  const [draft, setDraft] = React.useState<Settings | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [focusedWeight, setFocusedWeight] = React.useState<string | null>(null)
  const [activeSection, setActiveSection] = React.useState<string>(SECTIONS[0]?.id ?? "")
  /** Bumped when VPN settings are saved, so the status panel re-reads the verdict. */
  const [vpnRevision, setVpnRevision] = React.useState(0)

  const load = React.useCallback(() => {
    setLoadError(null)
    fetchSettings()
      .then((response) => {
        setServer(response)
        setDraft(response.settings)
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Could not load settings"))
  }, [])

  React.useEffect(load, [load])

  // Sections whose draft differs from what the server holds
  const dirty = React.useMemo(() => {
    if (!draft || !server) return [] as SettingsSection[]
    return (Object.keys(draft) as SettingsSection[]).filter((section) => JSON.stringify(draft[section]) !== JSON.stringify(server.settings[section]))
  }, [draft, server])

  const errors = React.useMemo(() => {
    const all: Partial<Record<SettingsSection, Record<string, string>>> = {}
    if (!draft) return all
    for (const section of dirty) all[section] = sectionErrors(section, draft[section])
    return all
  }, [draft, dirty])
  const invalidCount = Object.values(errors).reduce((sum, section) => sum + Object.keys(section ?? {}).length, 0)

  /** Replaces one field of one section in the draft. */
  function edit(section: SettingsSection, key: string, value: unknown) {
    setSaveError(null)
    setDraft((current) => (current ? ({ ...current, [section]: { ...current[section], [key]: value } } as Settings) : current))
  }

  const save = React.useCallback(async () => {
    if (!draft || dirty.length === 0 || invalidCount > 0) return
    setSaving(true)
    setSaveError(null)
    const patch: SettingsPatch = {}
    for (const section of dirty) {
      if (section === "services") patch.services = servicesPatch(draft)
      else Object.assign(patch, { [section]: draft[section] })
    }
    try {
      const response = await updateSettings(patch)
      setServer(response)
      setDraft(response.settings)
      if (dirty.includes("vpn")) setVpnRevision((revision) => revision + 1)
      toast({ title: "Settings saved", description: dirty.includes("torrent") ? "The torrent port applies after Findr restarts." : undefined })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }, [draft, dirty, invalidCount, toast])

  /** Removes a stored key immediately, keeping any other unsaved edits. */
  async function clearSecret(field: SecretField) {
    try {
      const response = await updateSettings({ services: { [field]: "" } })
      setServer(response)
      setDraft((current) => (current ? { ...current, services: { ...current.services, [field]: "" } } : current))
      toast({ title: "Key removed" })
    } catch (error) {
      toast({ title: "Could not remove the key", description: error instanceof Error ? error.message : undefined, tone: "bad" })
    }
  }

  // ⌘S or Ctrl+S saves from anywhere on the page
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        save()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [save])

  // Search narrows fields; a section shows while any of its fields match
  const words = React.useMemo(() => queryWords(query), [query])
  const visible = React.useMemo(
    () =>
      SECTIONS.map((section) => ({
        section,
        fields: FIELDS.filter((field) => field.section === section.id && matchesAll(searchText(field, section), words)),
        matches: section.id === "accounts" ? matchesAll(`${section.title} ${section.keywords} ${section.description}`, words) : false,
      })).filter((entry) => entry.fields.length > 0 || entry.matches),
    [words],
  )

  // Scroll-spy: the section nearest the top of the viewport is the active one
  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top) setActiveSection(top.target.id.replace(/^section-/, ""))
      },
      { rootMargin: "-25% 0px -65% 0px" },
    )
    for (const element of document.querySelectorAll("[data-settings-section]")) observer.observe(element)
    return () => observer.disconnect()
  }, [visible, server])

  function jump(id: string) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
  }

  const dirtyTitles = dirty.map((section) => SECTIONS.find((entry) => entry.id === section)?.title ?? section)

  return (
    <div className="mx-auto max-w-[1600px] px-4 md:px-8">
      <PageHeader title="Settings" />

      {loadError ? (
        <EmptyState icon={WarningIcon} title="Settings did not load" description={loadError} action={<Button variant="ink" onClick={load}>Try again</Button>} />
      ) : (
        <div className="mt-8 grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[17rem_minmax(0,52rem)]">
          {/* Search and section index */}
          <aside className="bleed-band sticky top-[var(--chrome-height)] z-[2] -mt-2 py-3 lg:self-start lg:bg-transparent lg:py-0 lg:pt-2 lg:[box-shadow:none] lg:[clip-path:none]">
            <SearchField value={query} onChange={setQuery} label="Search settings" shortcut="/" data-page-search />
            <nav aria-label="Sections" className="scroll-x -mx-4 mt-3 flex gap-1 px-4 lg:mx-0 lg:mt-5 lg:flex-col lg:px-0">
              {visible.map(({ section }) => {
                const Icon = section.icon
                const active = activeSection === section.id
                const unsaved = dirty.includes(section.id as SettingsSection)
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => jump(section.id)}
                    aria-current={active || undefined}
                    className={cn(
                      "relative flex h-9 shrink-0 items-center gap-2.5 rounded-full px-3.5 text-left text-sm font-medium transition-colors duration-200 lg:h-10",
                      active ? "text-ink" : "text-ink-2 hover:bg-sunken hover:text-ink",
                    )}
                  >
                    {active && <motion.span layoutId="settings-marker" transition={SPRING_SNAP} className="absolute inset-0 rounded-full bg-surface shadow-ring" />}
                    <Icon aria-hidden weight={active ? "fill" : "bold"} className="relative size-4 shrink-0" />
                    <span className="relative flex-1 truncate">{section.title}</span>
                    {unsaved && <span aria-label="Unsaved" className="relative size-2 shrink-0 rounded-full bg-signal-strong" />}
                  </button>
                )
              })}
            </nav>
          </aside>

          {/* Sections */}
          <div className="min-w-0 pb-24">
            {!draft || !server ? (
              <SettingsSkeleton />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={MagnifyingGlassIcon}
                title="No settings match"
                description={<>Nothing matches <span className="font-semibold text-ink">“{query.trim()}”</span>. Try a broader word such as “size”, “key” or “port”.</>}
                action={<Button variant="ink" onClick={() => setQuery("")}>Clear search</Button>}
              />
            ) : (
              <AnimatePresence initial={false}>
                {visible.map(({ section, fields }) => (
                  <motion.section
                    key={section.id}
                    id={`section-${section.id}`}
                    data-settings-section
                    layout="position"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: 0.12 } }}
                    transition={{ duration: 0.35, ease: EASE_OUT }}
                    className="mb-12 scroll-mt-[calc(var(--chrome-height)+6.5rem)] lg:scroll-mt-[calc(var(--chrome-height)+1.5rem)]"
                  >
                    <SectionHeading section={section} warning={section.id === "llmFilter" && !server.configured.anthropicApiKey ? "No Anthropic API key is set under Services, so this filter is off." : null} />
                    <div className="mt-4 rounded-panel bg-surface px-4 shadow-ring md:px-6">
                      {section.id === "accounts" ? (
                        <Accounts />
                      ) : (
                        <>
                          {section.id === "scoring" && words.length === 0 && (
                            <div className="pt-5">
                              <WeightBar
                                focused={focusedWeight}
                                onFocus={setFocusedWeight}
                                weights={WEIGHT_KEYS.map((key) => ({
                                  key,
                                  label: FIELDS.find((field) => field.section === "scoring" && field.key === key)?.label ?? key,
                                  value: draft.scoring[key],
                                }))}
                              />
                            </div>
                          )}
                          {section.id === "vpn" && words.length === 0 && (
                            <div className="pt-5">
                              <VpnStatusPanel revision={vpnRevision} />
                            </div>
                          )}
                          <div className="divide-y divide-line">
                            {fields.map((field) => {
                              const sectionKey = field.section
                              return (
                                <FieldRow
                                  key={field.key}
                                  field={field}
                                  words={words}
                                  value={(draft[sectionKey] as Record<string, unknown>)[field.key]}
                                  onChange={(value) => edit(sectionKey, field.key, value)}
                                  error={errors[sectionKey]?.[field.key]}
                                  configured={field.control.kind === "secret" ? server.configured[field.key as SecretField] : undefined}
                                  onClearSecret={field.control.kind === "secret" ? () => clearSecret(field.key as SecretField) : undefined}
                                  onFocusField={sectionKey === "scoring" ? (key) => setFocusedWeight(key && (WEIGHT_KEYS as readonly string[]).includes(key) ? key : null) : undefined}
                                />
                              )
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </motion.section>
                ))}
              </AnimatePresence>
            )}
          </div>
        </div>
      )}

      <SaveDock dirty={dirtyTitles} invalidCount={invalidCount} saving={saving} error={saveError} onSave={save} onDiscard={() => server && setDraft(server.settings)} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface SectionHeadingProps {
  section: SectionDef
  warning: string | null
}

function SectionHeading({ section, warning }: SectionHeadingProps) {
  const Icon = section.icon
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-signal-soft text-signal-ink">
        <Icon aria-hidden weight="bold" className="size-5" />
      </span>
      <div className="min-w-0">
        <h2 className="heading text-2xl text-ink">{section.title}</h2>
        <p className="mt-1 max-w-[62ch] text-[0.875rem] leading-relaxed text-ink-2">{section.description}</p>
        <AnimatePresence initial={false}>
          {warning && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE} className="mt-2 flex items-center gap-1.5 text-[0.8125rem] font-medium text-warn">
              <WarningIcon aria-hidden weight="bold" className="size-4" />
              {warning}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div className="space-y-12">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index}>
          <div className="flex gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-6 w-48 rounded-full" />
              <Skeleton className="h-3.5 w-3/4 rounded-full" />
            </div>
          </div>
          <Skeleton className="mt-4 h-56 rounded-panel" />
        </div>
      ))}
    </div>
  )
}
