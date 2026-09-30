/**
 * Serves the built web app from the files embedded by the asset map.
 *
 * The same map works for both production targets. In a JS bundle the file
 * loader yields paths relative to the bundle (`./index-abc.html`); in a
 * compiled executable it yields absolute paths into Bun's virtual filesystem
 * (`/$bunfs/root/index-abc.html`). Resolving relative paths against this
 * module's directory handles both.
 */

import type { Context } from "hono"
import { isAbsolute, join } from "node:path"

/** Vite fingerprints everything under `/assets/`, so it can be cached forever. */
const IMMUTABLE_PREFIX = "/assets/"

export class WebAssets {
  /** URL path → absolute path of the embedded file. */
  private readonly files: Map<string, string>

  /** Maps each generated asset entry to a path `Bun.file` can open from anywhere. */
  constructor(assets: Record<string, string>) {
    this.files = new Map(
      Object.entries(assets).map(([url, file]) => [
        url,
        isAbsolute(file) ? file : join(import.meta.dir, file),
      ]),
    )
  }

  /**
   * Answers a GET for the web app. Known files are served directly; anything
   * else that looks like a client-side route falls back to `index.html` so the
   * router can take over. Paths with an extension that match nothing are real
   * misses and get a 404.
   */
  public serve(c: Context): Response | Promise<Response> {
    const path = new URL(c.req.url).pathname

    // Serve an exact match, with long-lived caching for fingerprinted assets
    const file = this.files.get(path)
    if (file) {
      const headers: Record<string, string> = path.startsWith(IMMUTABLE_PREFIX)
        ? { "Cache-Control": "public, max-age=31536000, immutable" }
        : {}
      return new Response(Bun.file(file), { headers })
    }

    // Missing static files are genuine 404s
    const lastSegment = path.split("/").at(-1) ?? ""
    if (lastSegment.includes(".")) return c.notFound()

    // Everything else is a client route — hand it to the SPA shell
    const index = this.files.get("/index.html")
    if (!index) return c.text("Web app was not embedded in this build", 500)
    return new Response(Bun.file(index), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    })
  }
}
