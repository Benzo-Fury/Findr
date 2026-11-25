/**
 * Checks the hardware again with the saved settings: whether its encoder
 * works, which video it decodes, and whether it scales and tone maps, so an
 * admin can see what transcodes will run on before anyone presses Play.
 */

import type { EncoderTestResult } from "@findr/types/playback"
import { SettingsStore } from "../../../lib/db/models/SettingsStore"
import { Ffmpeg } from "../../../lib/playback/Ffmpeg"
import HardwareProbe from "../../../lib/playback/HardwareProbe"
import { factory } from "../../../lib/routing/factory"

export default factory({
  admin: true,
  rateLimit: { max: 10, window: 60 },

  POST: async (c) => {
    if (!(await Ffmpeg.available())) return c.json<EncoderTestResult>({ ok: false, encoder: "", message: "ffmpeg isn't installed", hardware: null })
    const settings = SettingsStore.section("playback")
    const report = await HardwareProbe.getInstance().report(settings, true)

    // Asked for hardware but none works: transcodes still play, on the CPU
    const wanted = settings.hardwareAcceleration !== "none"
    const ok = !wanted || report.api !== "none"
    const message = ok
      ? report.api === "none"
        ? "Transcodes run on the CPU"
        : `Checked in ${(report.durationMs / 1000).toFixed(1)} s`
      : `No hardware encoder works here, so transcodes run on the CPU${report.message ? `: ${report.message}` : ""}`
    return c.json<EncoderTestResult>({ ok, encoder: report.encoder, message, hardware: report })
  },
})
