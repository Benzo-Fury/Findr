/**
 * Build-time ffmpeg embedding script — the asset map's counterpart for the
 * tools. Writes `src/_tools.map.ts`, which imports a gzipped ffmpeg and
 * ffprobe for one compile target with Bun's `file` loader, so
 * `bun build --compile` embeds them in that executable. `FfmpegLocator`
 * unpacks them beside the database on first run.
 *
 * The builds are pinned in `scripts/tools.json`: a download URL and the
 * SHA-256 of each archive. An archive that doesn't match is refused, so a
 * changed or tampered upstream file never reaches a release. Downloads and
 * unpacked binaries are cached in `.cache/tools/`, so only the first build
 * per version needs the network.
 *
 *   bun run scripts/toolmap.ts                      # the host's target
 *   bun run scripts/toolmap.ts --target linux-x64   # another target
 *   bun run scripts/toolmap.ts --empty              # no tools (source runs, type checking)
 *
 * A target `tools.json` doesn't list gets an empty map, and its executable
 * looks for ffmpeg on `PATH` instead. The generated file is a build artifact
 * and is not checked into version control.
 */

import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rename } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { parseArgs } from "node:util"
import manifest from "./tools.json"

// ---------- Types ---------- //

/** One pinned binary: the archive it comes in, the archive's hash, and its path inside. */
interface PinnedTool {
  url: string
  sha256: string
  member: string
}

type ToolName = "ffmpeg" | "ffprobe"

// ---------- Paths ---------- //

const root = `${import.meta.dir}/..`
const cache = `${root}/.cache/tools`
const outPath = `${root}/src/_tools.map.ts`

// ---------- Arguments ---------- //

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: "string" }, empty: { type: "boolean" } },
})

/** The host's target name, as the release files spell it. */
const hostTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const target = (values.target ?? hostTarget).replace(/^bun-/, "")

// ---------- Helpers ---------- //

/** Hex SHA-256 of some bytes. */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Writes a file under a temporary name, then renames it into place. */
async function writeWhole(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await Bun.write(temporary, bytes)
  await rename(temporary, path)
}

/** The archive's format, from its URL: a zip, or an xz-compressed tarball. */
function archiveKind(tool: PinnedTool): "zip" | "tar.xz" {
  if (tool.url.endsWith(".zip")) return "zip"
  if (tool.url.endsWith(".tar.xz")) return "tar.xz"
  throw new Error(`${tool.url} is neither a .zip nor a .tar.xz`)
}

/** The archive for a pinned tool, downloaded once and checked against its pinned hash. */
async function archive(tool: PinnedTool): Promise<string> {
  const path = join(cache, "archives", `${tool.sha256}.${archiveKind(tool)}`)
  if (existsSync(path)) return path

  console.log(`Tools: downloading ${tool.url}`)
  const response = await fetch(tool.url)
  if (!response.ok) throw new Error(`${tool.url} answered ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== tool.sha256) throw new Error(`${tool.url} has SHA-256 ${actual}, but tools.json pins ${tool.sha256}`)
  await writeWhole(path, bytes)
  return path
}

/**
 * The gzipped binary for one tool and the hash of the binary inside, unpacked
 * from its archive once and cached under the binary's own hash.
 */
async function prepare(name: ToolName, tool: PinnedTool): Promise<{ file: string; sha256: string }> {
  const marker = join(cache, target, `${name}.${tool.sha256}`)
  if (existsSync(marker)) {
    const binarySha = (await Bun.file(marker).text()).trim()
    const file = join(cache, target, binarySha.slice(0, 16), `${name}.gz`)
    if (existsSync(file)) return { file, sha256: binarySha }
  }

  // Pull the one member out of the archive, then compress it for embedding
  const path = await archive(tool)
  const extract = archiveKind(tool) === "zip" ? $`unzip -p ${path} ${tool.member}` : $`tar -xJOf ${path} ${tool.member}`
  const binary = new Uint8Array(await extract.quiet().arrayBuffer())
  if (binary.length === 0) throw new Error(`${tool.member} is missing from ${tool.url}`)
  const binarySha = sha256(binary)
  const file = join(cache, target, binarySha.slice(0, 16), `${name}.gz`)
  await writeWhole(file, Bun.gzipSync(binary, { level: 9 }))
  await writeWhole(marker, new TextEncoder().encode(`${binarySha}\n`))
  return { file, sha256: binarySha }
}

// ---------- Generation ---------- //

const pinned = (manifest.targets as Record<string, Record<ToolName, PinnedTool> | undefined>)[target]
const entries: string[] = []
const imports: string[] = []

if (!values.empty && pinned) {
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const { file, sha256: binarySha } = await prepare(name, pinned[name])
    imports.push(`import ${name} from ${JSON.stringify(relative(`${root}/src`, file))} with { type: "file" }`)
    entries.push(`  ${name}: { file: ${name}, sha256: ${JSON.stringify(binarySha)} }`)
  }
} else if (!values.empty) {
  console.warn(`Tools: tools.json pins no build for ${target}; its executable will look for ffmpeg on PATH`)
}

// TypeScript cannot type file-loader imports, so the generated module opts out
// of checking and declares its export type itself
const output = `// @ts-nocheck — generated by scripts/toolmap.ts; file-loader imports are untypeable
${imports.join("\n")}

/** The ffmpeg binaries embedded in this build: each gzipped file and the SHA-256 of the binary inside. */
export const tools: Partial<Record<"ffmpeg" | "ffprobe", { file: string; sha256: string }>> = {
${entries.join(",\n")}
}
`

await Bun.write(outPath, output)
console.log(entries.length > 0 ? `Tools: embedded ffmpeg ${manifest.version} for ${target} → src/_tools.map.ts` : "Tools: no tools embedded → src/_tools.map.ts")
