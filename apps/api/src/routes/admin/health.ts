/**
 * Live health of everything Findr depends on, and the server's version and
 * uptime, for the Admin page's System section. Admins only.
 */

import type { AdminHealth } from "@findr/types/admin"
import { SystemHealth } from "../../lib/admin/SystemHealth"
import { factory } from "../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 30, window: 60 },

  GET: async (c) => c.json<AdminHealth>(await new SystemHealth().check()),
})
