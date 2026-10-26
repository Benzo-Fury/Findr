/**
 * Fills in settings a fresh install can work out for itself, so the setup
 * wizard has less to ask. Each only fills a setting that is still empty, and
 * never changes one an admin has set:
 *
 * - the Prowlarr URL from `PROWLARR_URL`;
 * - the Prowlarr API key from Prowlarr's own `config.xml` (`PROWLARR_CONFIG`),
 *   which Prowlarr writes on its first start — possibly after Findr's, so
 *   this runs again whenever the wizard checks;
 * - in a container, the library paths, as folders under `/media`. Keeping
 *   downloads on the same mount as the library means saving stays an atomic
 *   rename.
 */

import { mkdir, readFile } from "node:fs/promises"
import type { PathsSettings, SettingsPatch } from "@findr/types/settings"
import { SettingsStore } from "../db/models/SettingsStore"
import { Container } from "../env/Container"
import { env } from "../env/Env"

/** Library folders a container starts with. */
export const CONTAINER_PATHS: PathsSettings = {
  downloads: "/media/downloads",
  movies: "/media/movies",
  series: "/media/tv",
}

export class SetupDefaults {
  /** Fills whatever is still empty and can be worked out. Never throws. */
  public static async apply(): Promise<void> {
    const { services, paths } = SettingsStore.load()
    const patch: SettingsPatch = {}

    // Prowlarr, from the environment and its own config file
    if (!services.prowlarrUrl && env.PROWLARR_URL) patch.services = { prowlarrUrl: env.PROWLARR_URL }
    if (!services.prowlarrApiKey && env.PROWLARR_CONFIG) {
      const key = await this.prowlarrKey(env.PROWLARR_CONFIG)
      if (key) patch.services = { ...patch.services, prowlarrApiKey: key }
    }

    // A container's library lives on the one /media mount
    if (Container.inside) {
      const missing = (Object.keys(CONTAINER_PATHS) as Array<keyof PathsSettings>).filter((key) => !paths[key])
      if (missing.length > 0) {
        patch.paths = Object.fromEntries(missing.map((key) => [key, CONTAINER_PATHS[key]]))
        for (const key of missing) await mkdir(CONTAINER_PATHS[key], { recursive: true }).catch(() => {})
      }
    }

    if (Object.keys(patch).length === 0) return
    try {
      SettingsStore.update(patch)
      console.log(`[Setup] Filled in ${Object.entries(patch).flatMap(([section, fields]) => Object.keys(fields).map((field) => `${section}.${field}`)).join(", ")}`)
    } catch (error) {
      console.warn(`[Setup] Could not fill in defaults: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** The API key in a Prowlarr `config.xml`, or null when it can't be read yet. */
  public static async prowlarrKey(path: string): Promise<string | null> {
    try {
      const xml = await readFile(path, "utf8")
      return /<ApiKey>\s*([A-Za-z0-9]{16,64})\s*<\/ApiKey>/.exec(xml)?.[1] ?? null
    } catch {
      return null
    }
  }
}
