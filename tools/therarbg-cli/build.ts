/**
 * Builds the therarbg-cli Rust binary in release mode using Cargo.
 *
 * The compiled binary lands at `target/release/therarbg-cli` and is
 * then copied to `build/therarbg-cli` so the root build pipeline can
 * pick it up from a predictable location.
 *
 * Run via `bun run rust/therarbg-cli/build.ts` from the repo root.
 */

import { $ } from "bun"
import { mkdir, copyFile } from "node:fs/promises"
import { join } from "node:path"

const dir = import.meta.dir
const distDir = join(dir, "..", "..", "dist")
const binaryName = "therarbg-cli"

await $`cargo build --release`.cwd(dir)

await mkdir(distDir, { recursive: true })
await copyFile(
  join(dir, "target", "release", binaryName),
  join(distDir, binaryName),
)

console.log(`Build: ${binaryName} → dist/${binaryName}`)
