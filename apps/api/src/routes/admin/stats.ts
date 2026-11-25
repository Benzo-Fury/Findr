/**
 * The Admin page's figures for one period: storage, downloads, the library
 * and playback. Admins only.
 */

import { AdminStatsQuerySchema, type AdminStats as Stats } from "@findr/types/admin"
import { AdminStats } from "../../lib/admin/AdminStats"
import { factory } from "../../lib/routing/factory"
import { queryOf } from "../../lib/routing/input"

export default factory({
  admin: true,
  rateLimit: { max: 60, window: 60 },

  GET: {
    query: AdminStatsQuerySchema,
    handler: async (c) => c.json<Stats>(await new AdminStats().build(queryOf(c, AdminStatsQuerySchema).range)),
  },
})
