/**
 * Production build pipeline for the API. Runs in sequence:
 *
 * 1. **Cartographer** — scans `src/routes/` and generates `src/_route.map.ts`
 *    with static imports for every route file.
 * 2. **Asset map** — scans the built web app and generates `src/_asset.map.ts`,
 *    importing every file with the `file` loader so it ships with the build.
 * 3. **Bundle** — `Bun.build` bundles `src/index.ts` into `dist/index.js`,
 *    copying the web files into `dist/web/`.
 * 4. **Compile** — `bun build --compile` produces the standalone `dist/findr`
 *    executable with the web files embedded in it.
 *
 * `process.env.NODE_ENV` is inlined as `"production"` in both outputs so the
 * dev-only route glob and Vite proxy are dead-code eliminated.
 *
 * Expects the web app to already be built into `apps/web/dist/` — the root
 * `scripts/build.ts` orchestrator guarantees that ordering.
 */

import { $ } from "bun"

// ---------- Paths ---------- //

const root = `${import.meta.dir}/..`
const entry = `${root}/src/index.ts`
const dist = `${root}/../../dist`
const define = { "process.env.NODE_ENV": '"production"' }

// ---------- Code generation ---------- //

await $`bun run ${import.meta.dir}/cartographer.ts`
await $`bun run ${import.meta.dir}/assetmap.ts`

// ---------- Bundle ---------- //

const result = await Bun.build({
  entrypoints: [entry],
  outdir: dist,
  target: "bun",
  minify: true,
  define,
  naming: { asset: "web/[name]-[hash].[ext]" },
})

// Surface every bundler diagnostic before failing the build
if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Build: bundled ${result.outputs.length} file(s) → dist/`)

// ---------- Compile ---------- //

await $`bun build ${entry} --compile --minify --define process.env.NODE_ENV=${define["process.env.NODE_ENV"]} --outfile ${dist}/findr`.quiet()

console.log("Build: compiled standalone executable → dist/findr")
