/**
 * What playback the web app should offer: whether it is switched on, whether
 * video may be transcoded, whether ffmpeg is installed, and whether casting
 * is offered and from what address. Answers even while playback is off, so
 * the app knows to hide it.
 */

import type { PlaybackCapabilities } from "@findr/types/playback"
import { SettingsStore } from "../../lib/db/models/SettingsStore"
import { CastAddress } from "../../lib/playback/CastAddress"
import { Ffmpeg } from "../../lib/playback/Ffmpeg"
import { LocalNetwork } from "../../lib/playback/LocalNetwork"
import { factory } from "../../lib/routing/factory"

export default factory({
  GET: async (c) => {
    const settings = SettingsStore.section("playback")
    const capabilities: PlaybackCapabilities = {
      enabled: settings.enabled,
      transcoding: settings.transcoding,
      ffmpeg: await Ffmpeg.available(),
      casting: settings.enabled && settings.casting,
      castBaseUrl: settings.casting ? CastAddress.forClient(LocalNetwork.includes(c)) : null,
    }
    return c.json(capabilities)
  },
})
