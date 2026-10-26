/**
 * Starts the server, as `index.ts` does unless told to run a cast bridge.
 * Brings BetterAuth's schema up to date, registers every route, starts
 * listening, checks the VPN killswitch, finds ffmpeg, then recovers the download queue —
 * closing out anything a previous process left mid-flight and resuming
 * unfinished downloads — then starts playback and checking for updates.
 */

import { Server } from "./lib/server/Server"
import { migrateAuth, seedRoot } from "./lib/auth/client"
import { FfmpegLocator } from "./lib/media/FfmpegLocator"
import { SetupDefaults } from "./lib/setup/SetupDefaults"
import DownloadQueue from "./lib/pipeline/DownloadQueue"
import PlaybackService from "./lib/playback/PlaybackService"
import Updater from "./lib/updates/Updater"
import VpnGuard from "./lib/vpn/VpnGuard"

// A library failing outside any awaited call (a torrent socket, a NAT mapper)
// must not take the server down with it; the attempt it belonged to fails on
// its own through the heartbeat or the downloader's error state
process.on("unhandledRejection", (reason) => console.error("[Process] Unhandled rejection:", reason))
process.on("uncaughtException", (error) => console.error("[Process] Uncaught exception:", error))

// Create BetterAuth's tables before any request can hit them, then make
// sure a fresh install has an admin to sign in with
await migrateAuth()
await seedRoot()

// Fill in settings a fresh install can work out itself (Prowlarr in the Docker stack, container paths)
await SetupDefaults.apply()

const server = new Server()

await server.constructRoutes()

server.start()

// Know whether the VPN is up before anything can start a torrent
await VpnGuard.getInstance().start()

// Find ffmpeg and ffprobe (unpacking the bundled copies on first run) before
// anything is cleaned or played
await FfmpegLocator.resolve()

// Resume work only once the server is up, so a slow client never delays it
await DownloadQueue.getInstance().recover()

// Start playback, if enabled, which indexes any library files not yet probed
await PlaybackService.getInstance().start()

// Look for a new release now and every few hours. Before restarting into
// one, stop the route watch and free the port for the new process
Updater.getInstance().start(async () => {
  VpnGuard.getInstance().stop()
  await PlaybackService.getInstance().stop()
  await server.stop()
})
