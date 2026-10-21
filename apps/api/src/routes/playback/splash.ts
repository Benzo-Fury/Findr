/** The splash a TV shows while it is picked to cast to; fetched by the TV itself, so it needs no sign-in. */

import splash from "../../lib/playback/dlna/assets/splash.jpg" with { type: "file" }
import { factory } from "../../lib/routing/factory"

export default factory({
  authenticated: false,

  GET: () => new Response(Bun.file(splash), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } }),
})
