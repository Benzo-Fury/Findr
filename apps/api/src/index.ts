/**
 * Application entry point. Brings BetterAuth's schema up to date, registers
 * every route, starts listening, checks the VPN killswitch, then recovers
 * the download queue — closing out anything a previous process left
 * mid-flight and resuming unfinished downloads.
 */

import { Server } from "./lib/server/Server"
import { migrateAuth, seedRoot } from "./lib/auth/client"
import DownloadQueue from "./lib/pipeline/DownloadQueue"
import VpnGuard from "./lib/vpn/VpnGuard"

// Create BetterAuth's tables before any request can hit them, then make
// sure a fresh install has an admin to sign in with
await migrateAuth()
await seedRoot()

const server = new Server()

await server.constructRoutes()

server.start()

// Know whether the VPN is up before anything can start a torrent
await VpnGuard.getInstance().start()

// Resume work only once the server is up, so a slow client never delays it
await DownloadQueue.getInstance().recover()
