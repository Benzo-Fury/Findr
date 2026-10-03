/**
 * Runs every VPN check now, looking the public address up afresh, and
 * answers with the result. Admins use it to test the killswitch from the
 * settings page.
 */

import VpnGuard from "../../lib/vpn/VpnGuard"
import { factory } from "../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 20, window: 60 },

  POST: async (c) => c.json(await VpnGuard.getInstance().check({ lookupIp: true })),
})
