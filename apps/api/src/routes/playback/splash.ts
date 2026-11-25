/** The splash a TV shows while it is picked to cast to; fetched by the TV itself, so it needs no sign-in. */

import splash from "../../lib/playback/dlna/assets/splash.jpg" with { type: "file" }
import { SPLASH_FEATURES } from "../../lib/playback/dlna/DlnaController"
import { factory } from "../../lib/routing/factory"

export default factory({
  authenticated: false,

  // Labelled as DLNA labels a photo, which some TVs need before they show one
  GET: () =>
    new Response(Bun.file(splash), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
        "transferMode.dlna.org": "Interactive",
        "contentFeatures.dlna.org": SPLASH_FEATURES,
      },
    }),
})
