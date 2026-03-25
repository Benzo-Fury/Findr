/**
 * Derives a Hono-compatible route path from a file's relative path within the
 * `src/routes/` directory. Used by both the cartographer (build-time) and
 * dev-mode route discovery so the mapping logic lives in one place.
 *
 * Strips the `.ts` extension, converts `[...name]` catch-all segments into
 * wildcard paths, converts `[name]` dynamic segments into Hono `:name`
 * parameters, collapses `index` segments (so `auth/[...index].ts` becomes
 * `/auth/**`, `stores/index.ts` becomes `/stores`, and `stores/[id].ts`
 * becomes `/stores/:id`), and prepends a leading `/`.
 */
export function derivePath(relativePath: string): string {
  const stripped = relativePath
    .replace(/\.ts$/, "")
    .replace(/\[\.\.\.(\w+)\]/g, "$1/**")
    .replace(/\[(\w+)\]/g, ":$1")
    .replace(/\/index\/\*\*$/, "/**")
    .replace(/\/index$/, "")

  return "/api/" + stripped
}
