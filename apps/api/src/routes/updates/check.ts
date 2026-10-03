/**
 * Asks GitHub for the latest release now, rather than waiting for the next
 * scheduled check, and answers with the result.
 */

import Updater from "../../lib/updates/Updater"
import { factory } from "../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 10, window: 60 },

  POST: async (c) => c.json(await Updater.getInstance().check()),
})
