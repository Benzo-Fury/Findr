/**
 * What the setup wizard checks: whether ffmpeg and ffprobe were found, the
 * services configured and the library folders usable. `complete` is true once
 * everything downloads need is in place; Prowlarr being unreachable for a
 * moment doesn't hold it back. `?refresh=true` looks for the tools again,
 * after an admin has installed ffmpeg.
 *
 * Fills in what can be worked out first (`SetupDefaults`), so a Docker
 * install finds Prowlarr's key as soon as Prowlarr has written it.
 */

import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { SetupStatusQuerySchema, type PathStatus, type SetupStatus } from "@findr/types/setup"
import { SettingsStore } from "../../lib/db/models/SettingsStore"
import { FfmpegLocator } from "../../lib/media/FfmpegLocator"
import Prowlarr from "../../lib/prowlarr/Prowlarr"
import { factory } from "../../lib/routing/factory"
import { queryOf } from "../../lib/routing/input"
import { SetupDefaults } from "../../lib/setup/SetupDefaults"

/** Whether a folder is set, exists, and can be written (or made, by its nearest existing parent). */
async function pathStatus(path: string): Promise<PathStatus> {
  if (!path) return { set: false, exists: false, writable: false }
  const exists = await stat(path).then((info) => info.isDirectory(), () => false)

  // A folder that doesn't exist yet is made by the first download, so its nearest existing parent decides
  let probe = path
  while (!exists && dirname(probe) !== probe && !(await stat(probe).then(() => true, () => false))) probe = dirname(probe)
  const writable = await access(probe, constants.W_OK).then(() => true, () => false)
  return { set: true, exists, writable }
}

export default factory({
  admin: true,

  GET: {
    query: SetupStatusQuerySchema,
    handler: async (c) => {
      await SetupDefaults.apply()
      const refresh = queryOf(c, SetupStatusQuerySchema).refresh === "true"

      const { services, paths } = SettingsStore.load()
      const prowlarrConfigured = Boolean(services.prowlarrUrl && services.prowlarrApiKey)
      const [tools, reachable, downloads, movies, series] = await Promise.all([
        FfmpegLocator.resolve(refresh),
        prowlarrConfigured ? Prowlarr.getInstance().reachable() : Promise.resolve(null),
        pathStatus(paths.downloads),
        pathStatus(paths.movies),
        pathStatus(paths.series),
      ])

      const status: Omit<SetupStatus, "complete"> = {
        tools,
        tmdb: { configured: Boolean(services.tmdbApiKey) },
        prowlarr: { configured: prowlarrConfigured, reachable },
        paths: { downloads, movies, series },
      }
      const complete =
        tools.every((tool) => tool.path !== null) &&
        status.tmdb.configured &&
        prowlarrConfigured &&
        [downloads, movies, series].every((path) => path.set && path.writable)
      return c.json<SetupStatus>({ ...status, complete })
    },
  },
})
