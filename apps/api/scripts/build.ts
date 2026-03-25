/**
 * Production build pipeline. Orchestrates two steps in sequence:
 *
 * 1. **Cartographer** — scans `src/routes/` and generates `src/_route.map.ts`
 *    with static imports for every route file.
 * 2. **Bun.build** — bundles `src/index.ts` (which now statically imports the
 *    route map) into a single minified file at `build/index.js`, targeting the
 *    Bun runtime.
 *
 * `process.env.NODE_ENV` is inlined as `"production"` via `define` so the
 * bundler can dead-code-eliminate the dev-only dynamic import path in
 * `src/index.ts`.
 *
 * Run via `bun run build` from the `apps/api` workspace.
 */

import { $ } from "bun"

await $`bun run ${import.meta.dir}/cartographer.ts`

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/index.ts`],
  outdir: `${import.meta.dir}/../../../dist`,
  target: "bun",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Build: bundled ${result.outputs.length} file(s) → dist/`)
