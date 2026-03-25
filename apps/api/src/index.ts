/**
 * Application entry point. Creates a Server instance, discovers and registers
 * all routes, then starts listening on the configured port.
 */

import { Server } from "./lib/server/Server"
import JobQueue from "./lib/jobs/JobQueue"

const server = new Server()

await server.constructRoutes()

server.start()

JobQueue.getInstance()
