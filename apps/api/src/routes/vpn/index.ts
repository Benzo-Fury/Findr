/**
 * The VPN killswitch's latest verdict, for admins: whether torrent traffic is
 * allowed, why not, and what the checks saw. Configured under the `vpn`
 * settings section.
 */

import VpnGuard from "../../lib/vpn/VpnGuard"
import { factory } from "../../lib/routing/factory"

export default factory({
  admin: true,

  GET: (c) => c.json(VpnGuard.getInstance().status),
})
