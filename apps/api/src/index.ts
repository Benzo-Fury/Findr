/**
 * Application entry point. `findr bridge …` runs Findr as a cast bridge, on
 * another network, driving the TVs there for a server; anything else starts
 * the server. Each is imported only when chosen, so a bridge never opens a
 * database or reads settings.
 */

if (process.argv[2] === "bridge") {
  const { BridgeAgent } = await import("./lib/playback/bridge/BridgeAgent")
  await BridgeAgent.run(process.argv.slice(3))
} else {
  await import("./serve")
}

export {}
