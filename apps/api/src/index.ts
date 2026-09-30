/**
 * Application entry point. Brings BetterAuth's schema up to date, registers
 * every route, starts listening, then recovers the download queue — closing
 * out anything a previous process left mid-flight and resuming unfinished
 * downloads.
 */

import { Server } from "./lib/server/Server"
import { bootstrapAdmin, migrateAuth } from "./lib/auth/client"
import DownloadQueue from "./lib/pipeline/DownloadQueue"

// Create BetterAuth's tables before any request can hit them, then make
// sure a fresh install has an admin to sign in with
await migrateAuth()
await bootstrapAdmin()

const server = new Server()

await server.constructRoutes()

server.start()

// Resume work only once the server is up, so a slow client never delays it
await DownloadQueue.getInstance().recover()
