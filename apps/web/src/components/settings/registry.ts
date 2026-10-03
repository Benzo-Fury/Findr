/**
 * Every setting the Settings page shows, described once: which section and
 * field it edits, how it is labelled and explained, the words it can be found
 * by, and which control edits it. The page renders, searches and validates
 * from this list, so adding a setting is one entry here.
 */

import {
  FolderIcon,
  GaugeIcon,
  GlobeIcon,
  PlugsIcon,
  QueueIcon,
  RankingIcon,
  RobotIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TextAaIcon,
  TimerIcon,
  UsersIcon,
  type Icon,
} from "@phosphor-icons/react"
import { ReleaseTypeSchema, ResolutionSchema } from "@findr/types/media"
import type { Settings, SettingsSection } from "@findr/types/settings"

/** How a field is edited. */
export type FieldControl =
  | { kind: "text"; placeholder?: string; mono?: boolean }
  | { kind: "secret" }
  | { kind: "number"; min?: number; max?: number; step?: number; unit?: string }
  | { kind: "toggle" }
  | { kind: "order"; options: readonly string[] }
  | { kind: "multi"; options: readonly string[] }

/** One field of one settings section. */
export interface FieldDef<S extends SettingsSection = SettingsSection> {
  section: S
  key: keyof Settings[S] & string
  label: string
  help?: string
  /** Extra words people might search for. */
  keywords?: string
  control: FieldControl
}

/** A group on the page. `accounts` is managed separately from the settings store. */
export interface SectionDef {
  id: SettingsSection | "accounts"
  title: string
  description: string
  icon: Icon
  keywords?: string
}

export const SECTIONS: readonly SectionDef[] = [
  { id: "services", title: "Services", description: "The services Findr searches and looks titles up with. Keys are stored on the server and never shown again.", icon: PlugsIcon, keywords: "api key prowlarr tmdb anthropic indexer" },
  { id: "paths", title: "Library paths", description: "Absolute paths on the server. Downloads are staged in the first and moved into the others when finished.", icon: FolderIcon, keywords: "folder directory disk storage" },
  { id: "naming", title: "Naming", description: "Tokens: {title}, {year}, {season}, {episode}. Files always end in .mkv.", icon: TextAaIcon, keywords: "template rename filename" },
  { id: "preferences", title: "Release preferences", description: "Which releases are allowed at all, and which resolutions come first.", icon: SlidersHorizontalIcon, keywords: "quality filter blacklist" },
  { id: "scoring", title: "Scoring weights", description: "How much each quality signal counts when ranking releases that passed the filters. Each weight is the most that signal can add.", icon: RankingIcon, keywords: "rank score weight priority" },
  { id: "queue", title: "Queue", description: "How many downloads run at once, and how many releases each tries before giving up.", icon: QueueIcon, keywords: "concurrency parallel retries" },
  { id: "watchdog", title: "Download watchdog", description: "Abandon a release for the next one when it is not going to finish.", icon: TimerIcon, keywords: "timeout stall slow speed stuck hang frozen" },
  { id: "llmFilter", title: "Wrong-title filter", description: "Uses Claude to drop releases that are clearly for a different title before anything downloads. Falls back to no filtering on any error.", icon: RobotIcon, keywords: "ai claude llm anthropic model" },
  { id: "torrent", title: "Torrent client", description: "The built-in BitTorrent client. Forward the port on your router for better speeds.", icon: GaugeIcon, keywords: "bittorrent port network dht peers" },
  { id: "vpn", title: "VPN killswitch", description: "Torrents run only while your VPN is connected, and every torrent connection is bound to its address. The moment a check fails every connection is cut and downloads wait until the VPN is back. For a hard guarantee, also run Findr inside the VPN's network.", icon: ShieldCheckIcon, keywords: "vpn killswitch kill switch leak privacy wireguard openvpn tunnel ip" },
  { id: "access", title: "Access", description: "Where Findr is served, and who may reach it. It only answers requests from this machine unless remote access is on. Behind a reverse proxy on the same machine, also set TRUST_PROXY on the server.", icon: GlobeIcon, keywords: "remote network lan proxy security url address" },
  { id: "accounts", title: "Accounts", description: "Sign-up is disabled. Create an account here for anyone who should have access.", icon: UsersIcon, keywords: "users people password email admin role" },
]

/** Builds a field definition typed to its section. */
function field<S extends SettingsSection>(definition: FieldDef<S>): FieldDef {
  return definition as unknown as FieldDef
}

export const FIELDS: readonly FieldDef[] = [
  // Services
  field({ section: "services", key: "prowlarrUrl", label: "Prowlarr URL", help: "Where Findr searches for releases.", control: { kind: "text", placeholder: "http://localhost:9696", mono: true } }),
  field({ section: "services", key: "prowlarrApiKey", label: "Prowlarr API key", control: { kind: "secret" } }),
  field({ section: "services", key: "tmdbApiKey", label: "TMDB API key", help: "Used for browsing, artwork, episode lists and naming.", control: { kind: "secret" } }),
  field({ section: "services", key: "anthropicApiKey", label: "Anthropic API key", help: "Optional. Turns on the wrong-title filter.", keywords: "claude", control: { kind: "secret" } }),

  // Paths
  field({ section: "paths", key: "downloads", label: "Downloads", help: "Scratch space for attempts in progress.", keywords: "temp staging", control: { kind: "text", placeholder: "/srv/findr/downloads", mono: true } }),
  field({ section: "paths", key: "movies", label: "Movies library", control: { kind: "text", placeholder: "/srv/media/movies", mono: true } }),
  field({ section: "paths", key: "series", label: "TV library", keywords: "shows series", control: { kind: "text", placeholder: "/srv/media/tv", mono: true } }),

  // Naming
  field({ section: "naming", key: "movieFolder", label: "Movie folder", control: { kind: "text", mono: true } }),
  field({ section: "naming", key: "movieFile", label: "Movie file", control: { kind: "text", mono: true } }),
  field({ section: "naming", key: "seriesFolder", label: "Show folder", control: { kind: "text", mono: true } }),
  field({ section: "naming", key: "seasonFolder", label: "Season folder", control: { kind: "text", mono: true } }),
  field({ section: "naming", key: "seriesFile", label: "Episode file", control: { kind: "text", mono: true } }),

  // Preferences
  field({ section: "preferences", key: "resolutions", label: "Resolutions", help: "Drag to set the order of preference. Resolutions left out score nothing for resolution.", keywords: "1080p 720p 2160p 4k quality", control: { kind: "order", options: ResolutionSchema.options } }),
  field({ section: "preferences", key: "blacklistedReleaseTypes", label: "Never download", help: "Release types that are rejected outright.", keywords: "cam telesync blacklist block", control: { kind: "multi", options: ReleaseTypeSchema.options } }),
  field({ section: "preferences", key: "maxFileSizeGB", label: "Largest file", help: "Per movie or per episode. Season packs scale it by episode count.", keywords: "size limit", control: { kind: "number", min: 0.5, step: 0.5, unit: "GB" } }),
  field({ section: "preferences", key: "minSeeders", label: "Minimum seeders", keywords: "peers swarm", control: { kind: "number", min: 0, step: 1 } }),

  // Scoring
  field({ section: "scoring", key: "resolution", label: "Resolution", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "fileSize", label: "File size", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "seeders", label: "Seeders", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "codec", label: "Codec", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "releaseType", label: "Release type", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "releaseGroup", label: "Release group", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "uploadDate", label: "Upload recency", keywords: "age date new", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "repack", label: "Repack bonus", keywords: "proper rerip", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "idealMovieSizeGB", label: "Ideal size per movie", help: "Scores fall away on a bell curve either side.", control: { kind: "number", min: 0.1, step: 0.5, unit: "GB" } }),
  field({ section: "scoring", key: "idealEpisodeSizeGB", label: "Ideal size per episode", control: { kind: "number", min: 0.1, step: 0.1, unit: "GB" } }),
  field({ section: "scoring", key: "seederCap", label: "Seeder cap", help: "More seeders than this stop adding score.", control: { kind: "number", min: 1, step: 50 } }),
  field({ section: "scoring", key: "bloated4KPenalty", label: "Oversized 4K penalty", keywords: "2160p bloated", control: { kind: "number", min: 0, step: 1 } }),
  field({ section: "scoring", key: "bloated4KSizeGB", label: "4K counts as oversized above", help: "Per movie or episode.", keywords: "2160p bloated", control: { kind: "number", min: 1, step: 1, unit: "GB" } }),

  // Queue
  field({ section: "queue", key: "maxConcurrent", label: "Downloads at once", keywords: "parallel concurrent", control: { kind: "number", min: 1, max: 10, step: 1 } }),
  field({ section: "queue", key: "maxAttempts", label: "Attempts before giving up", help: "Per movie, season pack or episode.", keywords: "retries", control: { kind: "number", min: 1, max: 25, step: 1 } }),

  // Watchdog
  field({ section: "watchdog", key: "metadataTimeoutMinutes", label: "File list timeout", help: "How long a release may take to show its files.", keywords: "metadata magnet", control: { kind: "number", min: 1, step: 1, unit: "min" } }),
  field({ section: "watchdog", key: "stallTimeoutMinutes", label: "Stall timeout", help: "How long a download may go without a single new byte.", control: { kind: "number", min: 1, step: 1, unit: "min" } }),
  field({ section: "watchdog", key: "minSpeedKBps", label: "Minimum average speed", help: "Zero turns the speed check off.", keywords: "slow bandwidth", control: { kind: "number", min: 0, step: 10, unit: "KB/s" } }),
  field({ section: "watchdog", key: "speedWindowMinutes", label: "Speed window", help: "The span the average speed is measured over.", control: { kind: "number", min: 1, step: 1, unit: "min" } }),
  field({ section: "watchdog", key: "stuckTimeoutMinutes", label: "Stuck timeout", help: "How long any step may show no sign of life before the release is skipped. A slow download still counts as alive.", keywords: "hang frozen sterilize save", control: { kind: "number", min: 1, step: 1, unit: "min" } }),
  field({ section: "watchdog", key: "pollIntervalSeconds", label: "Check every", keywords: "poll interval", control: { kind: "number", min: 1, max: 60, step: 1, unit: "s" } }),

  // Wrong-title filter
  field({ section: "llmFilter", key: "enabled", label: "Filter wrong titles", help: "Only takes effect when an Anthropic API key is set.", control: { kind: "toggle" } }),
  field({ section: "llmFilter", key: "model", label: "Model", control: { kind: "text", mono: true } }),
  field({ section: "llmFilter", key: "maxCandidates", label: "Releases to screen", control: { kind: "number", min: 1, max: 50, step: 1 } }),
  field({ section: "llmFilter", key: "timeoutSeconds", label: "Timeout", control: { kind: "number", min: 1, max: 120, step: 1, unit: "s" } }),

  // Torrent
  field({ section: "torrent", key: "port", label: "Port", help: "TCP for peers, UDP for the DHT. 0 picks a random port. Applies after Findr restarts.", keywords: "restart forward router", control: { kind: "number", min: 0, max: 65535, step: 1 } }),

  // VPN killswitch
  field({ section: "vpn", key: "enabled", label: "Require a VPN for torrents", help: "Binds every torrent connection to the VPN, and turns off router port mapping, local peer discovery, HTTP trackers and web seeds.", keywords: "killswitch block", control: { kind: "toggle" } }),
  field({ section: "vpn", key: "interfaceName", label: "VPN interface", help: "The network interface your VPN creates, such as wg0 or tun0. End with * to match a prefix, such as utun* on macOS. Required: torrents are bound to its address, and stop if internet traffic would leave through any other interface.", keywords: "wireguard openvpn tun utun wg0 adapter network", control: { kind: "text", placeholder: "wg0", mono: true } }),
  field({ section: "vpn", key: "homeIps", label: "Home public IP", help: "Your connection's public IPv4 and IPv6 addresses, comma separated. Torrents stop if traffic leaves from one of them, or if the public IP cannot be looked up. Leave empty to skip this check.", keywords: "address leak ipv4 ipv6 isp", control: { kind: "text", placeholder: "198.51.100.7, 2001:db8::1", mono: true } }),

  // Access
  field({ section: "access", key: "port", label: "Port", help: "Where the web app and API are served. Applies after Findr restarts.", keywords: "http web restart", control: { kind: "number", min: 1, max: 65535, step: 1 } }),
  field({ section: "access", key: "publicUrl", label: "Public URL", help: "Only needed when Findr is opened at a hostname, such as through a reverse proxy. localhost and IP addresses always work. Applies after Findr restarts.", keywords: "base url domain hostname reverse proxy https", control: { kind: "text", placeholder: "https://findr.example.com", mono: true } }),
  field({ section: "access", key: "allowRemote", label: "Allow access from other machines", help: "Off by default, so a fresh install is reachable only from the server itself.", keywords: "remote lan", control: { kind: "toggle" } }),
]

/** The scoring weights drawn in the proportion bar, in display order. */
export const WEIGHT_KEYS = ["resolution", "fileSize", "seeders", "codec", "releaseType", "releaseGroup", "uploadDate", "repack"] as const
