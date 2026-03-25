/**
 * Production build pipeline. Builds both the API and web app in parallel.
 *
 * Invokes each app's own build script so the logic stays local to each app.
 * Run via `bun run build` from the repo root.
 */

import { $ } from "bun"

const root = `${import.meta.dir}/..`
const start = performance.now()

await Promise.all([
  $`bun run ${root}/apps/api/scripts/build.ts`,
  $`cd ${root}/apps/web && bunx tsc -b && bunx vite build`,
  $`bun run ${root}/rust/therarbg-cli/build.ts`,
])

const elapsed = ((performance.now() - start) / 1000).toFixed(2)
console.log(`Build complete in ${elapsed}s.`)
