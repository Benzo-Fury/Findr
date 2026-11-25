/**
 * Where an episode's end credits start, so the player can offer the next
 * episode then. The first ask may take several seconds while Findr asks
 * TheIntroDB or reads the file's ending; later ones are answered at once.
 */

import { CreditsQuerySchema, type CreditsRecord } from "@findr/types/playback"
import { MediaItem } from "../../lib/db/models/MediaItem"
import { MediaResponse } from "../../lib/playback/MediaResponse"
import CreditsLocator from "../../lib/playback/credits/CreditsLocator"
import { requirePlayback } from "../../lib/playback/requirePlayback"
import { factory } from "../../lib/routing/factory"
import { queryOf } from "../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  GET: {
    query: CreditsQuerySchema,
    handler: async (c) => {
      const item = MediaItem.findForKey(queryOf(c, CreditsQuerySchema))
      if (!item) return c.json({ error: "not_playable" }, 404)

      // Reading a file's ending can outlast the usual request timeout
      MediaResponse.allowSlow(c, 150)
      const record: CreditsRecord = { creditsMs: await CreditsLocator.getInstance().creditsOf(item) }
      return c.json(record)
    },
  },
})
