import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { database } from "../db/client"
import { SettingsStore } from "../db/models/SettingsStore"
import { env } from "../env/Env"
import { SetupDefaults } from "./SetupDefaults"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "findr-setup-"))
  database.run(`DELETE FROM settings`)
})

afterEach(async () => {
  env.PROWLARR_URL = undefined
  env.PROWLARR_CONFIG = undefined
  await rm(root, { recursive: true, force: true })
})

/** A Prowlarr config.xml as Prowlarr writes it. */
async function prowlarrConfig(key: string): Promise<string> {
  const path = join(root, "config.xml")
  await writeFile(path, `<Config>\n  <BindAddress>*</BindAddress>\n  <Port>9696</Port>\n  <ApiKey>${key}</ApiKey>\n  <AuthenticationMethod>None</AuthenticationMethod>\n</Config>\n`)
  return path
}

describe("SetupDefaults", () => {
  test("fills an empty Prowlarr URL and key from the environment and Prowlarr's config", async () => {
    env.PROWLARR_URL = "http://prowlarr:9696"
    env.PROWLARR_CONFIG = await prowlarrConfig("0123456789abcdef0123456789abcdef")

    await SetupDefaults.apply()

    const services = SettingsStore.section("services")
    expect(services.prowlarrUrl).toBe("http://prowlarr:9696")
    expect(services.prowlarrApiKey).toBe("0123456789abcdef0123456789abcdef")
  })

  test("never replaces what an admin set", async () => {
    SettingsStore.update({ services: { prowlarrUrl: "http://elsewhere:9696", prowlarrApiKey: "mine" } })
    env.PROWLARR_URL = "http://prowlarr:9696"
    env.PROWLARR_CONFIG = await prowlarrConfig("0123456789abcdef0123456789abcdef")

    await SetupDefaults.apply()

    expect(SettingsStore.section("services")).toMatchObject({ prowlarrUrl: "http://elsewhere:9696", prowlarrApiKey: "mine" })
  })

  test("waits quietly for a config file Prowlarr hasn't written yet", async () => {
    env.PROWLARR_CONFIG = join(root, "missing.xml")
    await SetupDefaults.apply()
    expect(SettingsStore.section("services").prowlarrApiKey).toBe("")
  })
})
