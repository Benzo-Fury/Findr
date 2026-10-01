/**
 * Production build orchestrator. Builds the web app, then the API — in that
 * order, because the API build embeds the web app's output.
 *
 * Produces `dist/index.js` (a single JS bundle, run with `bun`), `dist/web/`
 * (the web files that bundle serves), and `dist/findr` (a standalone
 * executable with everything embedded).
 *
 * Invokes each app's own build so the logic stays local to each app. Run via
 * `bun run build` from the repo root; arguments are passed to the API build,
 * so `bun run build --target linux-x64` cross-compiles `dist/findr-linux-x64`.
 */

import { $ } from "bun"
import { rm } from "node:fs/promises"

const root = `${import.meta.dir}/..`
const start = performance.now()

// Start from an empty dist so stale hashed assets never ship
await rm(`${root}/dist`, { recursive: true, force: true })

// Web first — the API build embeds its output
await $`cd ${root}/apps/web && bunx tsc -b && bunx vite build`
await $`bun run ${root}/apps/api/scripts/build.ts ${Bun.argv.slice(2)}`

const elapsed = ((performance.now() - start) / 1000).toFixed(2)
console.log(`Build complete in ${elapsed}s.`)
