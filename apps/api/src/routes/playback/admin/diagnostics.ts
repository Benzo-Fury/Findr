/**
 * What stops this machine playing as well as it could, worst first, each
 * with what to do about it: hardware unused or failing, devices a container
 * lacks, stages of a conversion left on the CPU, and room to work in. Uses
 * the last hardware check rather than running a new one; the encoder test
 * runs one.
 */

import type { PlaybackDiagnostics as Diagnostics } from "@findr/types/playback"
import { SettingsStore } from "../../../lib/db/models/SettingsStore"
import { PlaybackDiagnostics } from "../../../lib/playback/PlaybackDiagnostics"
import { factory } from "../../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 30, window: 60 },

  GET: async (c) => c.json<Diagnostics>(await PlaybackDiagnostics.run(SettingsStore.section("playback"))),
})
