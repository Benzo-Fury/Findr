/**
 * Encodes a few seconds of a test picture with the saved encoder settings,
 * so an admin can see whether hardware encoding works on this machine.
 */

import type { EncoderTestResult } from "@findr/types/playback"
import { SettingsStore } from "../../../lib/db/models/SettingsStore"
import { Ffmpeg } from "../../../lib/playback/Ffmpeg"
import { factory } from "../../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 10, window: 60 },

  POST: async (c) => {
    const settings = SettingsStore.section("playback")
    const encoder = Ffmpeg.encoderName(settings.hardwareAcceleration)
    if (!(await Ffmpeg.available())) return c.json<EncoderTestResult>({ ok: false, encoder, message: "ffmpeg isn't installed" })
    return c.json<EncoderTestResult>({ encoder, ...(await Ffmpeg.testEncoder(settings)) })
  },
})
