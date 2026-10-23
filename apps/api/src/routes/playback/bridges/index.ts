/**
 * The cast bridges admins have added, and adding one. A new bridge's token is
 * in the answer to the POST and nowhere else, ever.
 */

import { CreateCastBridgeSchema, type CreatedCastBridge } from "@findr/types/playback"
import { CastBridge } from "../../../lib/db/models/CastBridge"
import BridgeHub from "../../../lib/playback/bridge/BridgeHub"
import DlnaController from "../../../lib/playback/dlna/DlnaController"
import { factory } from "../../../lib/routing/factory"
import { bodyOf } from "../../../lib/routing/input"

export default factory({
  admin: true,

  GET: (c) => {
    const hub = BridgeHub.getInstance()
    const controller = DlnaController.getInstance()
    return c.json(CastBridge.all().map((bridge) => hub.record(bridge, controller.countOn(bridge.id))))
  },

  POST: {
    body: CreateCastBridgeSchema,
    handler: (c) => {
      const { bridge, token } = CastBridge.create(bodyOf(c, CreateCastBridgeSchema).name)
      const created: CreatedCastBridge = { bridge: BridgeHub.getInstance().record(bridge, 0), token }
      return c.json(created, 201)
    },
  },
})
