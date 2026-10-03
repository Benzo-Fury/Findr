/**
 * Installs the available update. Answers at once with the updater's status;
 * the new executable downloads in the background and Findr restarts into it.
 * Refused for a source checkout, while downloads are queued or running, and
 * when there is nothing newer.
 */

import Updater, { UpdateError } from "../../lib/updates/Updater"
import { factory } from "../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 10, window: 60 },

  POST: (c) => {
    try {
      return c.json(Updater.getInstance().install(), 202)
    } catch (error) {
      if (error instanceof UpdateError) return c.json({ error: error.code }, 409)
      throw error
    }
  },
})
