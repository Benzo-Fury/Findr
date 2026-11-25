/**
 * Where a cast bridge connects: a WebSocket, opened with the bridge's token
 * as a bearer token. A wrong token is refused before the upgrade; a right one
 * makes the bridge's network searchable and drivable until it disconnects.
 * Like the rest of the API, it is reachable from other machines only with
 * remote access on.
 */

import type { MiddlewareHandler } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { CastBridge } from "../../../lib/db/models/CastBridge"
import { SettingsStore } from "../../../lib/db/models/SettingsStore"
import BridgeHub from "../../../lib/playback/bridge/BridgeHub"
import type { BridgeSocket, BridgedRendererNetwork } from "../../../lib/playback/bridge/BridgedRendererNetwork"
import { requirePlayback } from "../../../lib/playback/requirePlayback"
import { factory, PUBLIC_RATE_LIMIT } from "../../../lib/routing/factory"

/** Refuses a request without a known bridge's token, and anything while casting is off. */
const requireBridge: MiddlewareHandler = async (c, next) => {
  if (!SettingsStore.section("playback").casting) return c.json({ error: "casting_disabled" }, 404)
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? ""
  const bridge = CastBridge.findByToken(token)
  if (!bridge) return c.json({ error: "bridge_unknown" }, 401)
  c.set("castBridge", bridge)
  await next()
}

export default factory({
  authenticated: false,
  rateLimit: PUBLIC_RATE_LIMIT,
  middleware: [requirePlayback, requireBridge],

  // Hono wraps the socket afresh for every event, so the one from opening stands for the connection
  GET: upgradeWebSocket((c) => {
    const bridge = c.get("castBridge")
    let connection: { network: BridgedRendererNetwork; socket: BridgeSocket } | null = null
    return {
      onOpen: (_event, socket) => {
        connection = { network: BridgeHub.getInstance().connect(bridge, socket), socket }
      },
      onMessage: (event) => {
        if (connection && typeof event.data === "string") connection.network.receive(connection.socket, event.data)
      },
      onClose: () => {
        if (!connection) return
        const { network, socket } = connection
        const wasConnected = network.connected
        network.detach(socket)
        if (wasConnected && !network.connected) console.log(`[Playback] Cast bridge ${network.place} disconnected`)
      },
    }
  }),
})
