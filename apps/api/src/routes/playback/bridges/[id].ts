/** Removes a cast bridge: its token stops working and it is disconnected at once. */

import { CastBridge } from "../../../lib/db/models/CastBridge"
import BridgeHub from "../../../lib/playback/bridge/BridgeHub"
import { factory } from "../../../lib/routing/factory"

export default factory({
  admin: true,

  DELETE: (c) => {
    const bridge = CastBridge.find(c.req.param("id") ?? "")
    if (!bridge) return c.json({ error: "not_found" }, 404)
    bridge.delete()
    BridgeHub.getInstance().remove(bridge.id)
    return c.body(null, 204)
  },
})
