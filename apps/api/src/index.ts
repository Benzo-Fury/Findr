/**
 * Application entry point. Brings BetterAuth's schema up to date, creates a
 * Server instance, discovers and registers all routes, then starts listening
 * on the configured port.
 */

import { Server } from "./lib/server/Server"
import { migrateAuth } from "./lib/auth/client"

// Create BetterAuth's tables before any request can hit them
await migrateAuth()

const server = new Server()

await server.constructRoutes()

server.start()
