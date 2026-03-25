/**
 * Build-time route discovery script. Scans `src/routes/` for every `.ts` file
 * and generates `src/_route.map.ts` — a module that statically imports each
 * route and re-exports them as a `Record<string, Route>` keyed by derived path.
 *
 * Each file's path within `src/routes/` is converted to a URL pattern via
 * `derivePath` (e.g. `health.ts` → `/health`, `[...auth].ts` → `/auth/**`).
 *
 * This generated file is what the production entry point imports, giving
 * `Bun.build` full visibility into the dependency graph so it can tree-shake
 * and bundle everything into a single output file.
 *
 * Run automatically by `scripts/build.ts` before bundling. Should never need
 * to be invoked manually, but can be via `bun run scripts/cartographer.ts`.
 *
 * The generated `_route.map.ts` is not checked into version control — it's
 * a build artifact that gets regenerated on every build.
 */

import { derivePath } from "../src/lib/routing/derivePath"

const glob = new Bun.Glob("**/*.ts")
const routesDir = `${import.meta.dir}/../src/routes`
const outPath = `${import.meta.dir}/../src/_route.map.ts`

const imports: string[] = []
const entries: string[] = []
let i = 0

for await (const path of glob.scan(routesDir)) {
  const name = `route${i++}`
  const importPath = path.replace(/\.ts$/, "")
  const routePath = derivePath(path)
  imports.push(`import ${name} from "./routes/${importPath}"`)
  entries.push(`  "${routePath}": ${name}`)
}

const output = `import type { Route } from "./types/Route"
${imports.join("\n")}

export const routes: Record<string, Route> = {
${entries.join(",\n")}
}
`

await Bun.write(outPath, output)
console.log(`Cartographer: mapped ${entries.length} route(s) → src/_route.map.ts`)
