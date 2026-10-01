/**
 * Production build pipeline for the API. Runs in sequence:
 *
 * 1. **Cartographer** — scans `src/routes/` and generates `src/_route.map.ts`
 *    with static imports for every route file.
 * 2. **Asset map** — scans the built web app and generates `src/_asset.map.ts`,
 *    importing every file with the `file` loader so it ships with the build.
 * 3. **Bundle** — `Bun.build` bundles `src/index.ts` into `dist/index.js`,
 *    copying the web files into `dist/web/`.
 * 4. **Compile** — `Bun.build` with `compile` produces the standalone
 *    `dist/findr` executable with the web files embedded in it. Pass
 *    `--target <bun target>` (repeatable, e.g. `linux-x64`, `linux-arm64`,
 *    `windows-x64`, `darwin-arm64`) to cross-compile `dist/findr-<target>`
 *    instead.
 *
 * Both outputs replace WebTorrent's optional native addons with stubs (see
 * `scripts/native-stubs.ts`), so the build is pure JavaScript, behaves the
 * same on every machine, and cross-compiles to any platform Bun targets.
 *
 * `process.env.NODE_ENV` is inlined as `"production"` in both outputs so the
 * dev-only route glob and Vite proxy are dead-code eliminated.
 *
 * Expects the web app to already be built into `apps/web/dist/` — the root
 * `scripts/build.ts` orchestrator guarantees that ordering.
 */

import { $ } from "bun"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { nativeStubsForBuild } from "./native-stubs"

// ---------- Paths ---------- //

const root = `${import.meta.dir}/..`
const entry = `${root}/src/index.ts`
const dist = `${root}/../../dist`
const define = { "process.env.NODE_ENV": '"production"' }

// ---------- Arguments ---------- //

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: "string", multiple: true } },
})

/** Accepts `linux-x64` or `bun-linux-x64`; Bun.build rejects anything it does not know. */
function compileTarget(name: string): Bun.Build.CompileTarget {
  const target = name.startsWith("bun-") ? name : `bun-${name}`
  if (!/^bun-(darwin|linux|windows)-/.test(target)) {
    console.error(`Unknown compile target "${name}" (try linux-x64, linux-arm64, windows-x64, darwin-arm64)`)
    process.exit(1)
  }
  return target as Bun.Build.CompileTarget
}
const targets = (values.target ?? []).map(compileTarget)

// ---------- Code generation ---------- //

await $`bun run ${import.meta.dir}/cartographer.ts`
await $`bun run ${import.meta.dir}/assetmap.ts`

// ---------- Bundle ---------- //

/** Runs one `Bun.build`, printing every diagnostic and exiting on failure. */
async function build(config: Bun.BuildConfig): Promise<Bun.BuildOutput> {
  const result = await Bun.build(config)
  if (!result.success) {
    console.error("Build failed:")
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  return result
}

const bundle = await build({
  entrypoints: [entry],
  outdir: dist,
  target: "bun",
  minify: true,
  define,
  plugins: [nativeStubsForBuild],
  naming: { asset: "web/[name]-[hash].[ext]" },
})

console.log(`Build: bundled ${bundle.outputs.length} file(s) → dist/`)

// ---------- Compile ---------- //

// The host platform by default, or each requested target
const compiles: Array<{ target?: Bun.Build.CompileTarget; outfile: string }> =
  targets.length > 0
    ? targets.map((target) => ({ target, outfile: `${dist}/findr-${target.replace(/^bun-/, "")}` }))
    : [{ outfile: `${dist}/findr` }]

for (const { target, outfile } of compiles) {
  await build({
    entrypoints: [entry],
    minify: true,
    define,
    plugins: [nativeStubsForBuild],
    compile: { outfile, ...(target ? { target } : {}) },
  })
  console.log(`Build: compiled standalone executable → dist/${basename(outfile)}`)
}
