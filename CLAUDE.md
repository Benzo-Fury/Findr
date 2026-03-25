# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
bun run dev:api          # Start API with hot reload (port 3030), proxies / to Vite
bun run dev:web          # Start Vite dev server (port 5173)
bun run dev              # Start both API and web concurrently

# Build & Production
bun run build            # Build everything → dist/ (API, web, Rust binary)
bun run build:api        # Run cartographer + Bun.build → dist/index.js
bun run build:web        # Vite production build → dist/public/
bun run start            # Run production bundle (serves API + web on port 3030)

# Type checking
cd apps/api && bunx tsc --noEmit   # Type check API
cd apps/web && bunx tsc --noEmit   # Type check web
```

## Architecture

Bun monorepo with two apps (`apps/api`, `apps/web`) and a shared `packages/` directory.

### API (`apps/api`)

**Runtime:** Bun + Hono. **Auth:** BetterAuth with MongoDB adapter (email+password).

**Shared types** — `@findr/types` (`packages/types`) is the single source of truth for data shapes. It exports Zod schemas and inferred TypeScript types.

**Routing system** — Path-based route discovery with a declarative Route type. Each file in `src/routes/` exports a single `factory()` Route; the URL path is derived from the file location (prefixed with `/api/`), never declared manually. Each HTTP method on a route can be a bare handler or a `MethodConfig` object (`{ handler, body? }`) for per-method body validation.

**Middleware** (`src/middleware/`) — `requireAuth` and `validateBody` live here. `validateBody` is inserted automatically when a route declares a `body` schema for a given method.

**Server class** (`src/lib/server/Server.ts`) extends Hono. Key methods:
- `constructRoutes()` — discovers routes then registers them with the Hono router under `/api/`, wiring auth, validation, and custom middleware into each method's chain. Also mounts the web app at `/` (static files in prod, Vite proxy in dev).
- `start()` — binds to port via `Bun.serve`

**Build output** — all builds output to `dist/` at the repo root: `dist/index.js` (API), `dist/public/` (web), `dist/therarbg-cli` (Rust binary). In production the API serves the web app's static files directly.

### Web (`apps/web`)

React 19 + TanStack Router + Vite. File-based routing via the TanStack Router plugin. Routes live in `src/routes/`.

## Conventions

- **Object-oriented systems** — major libraries and systems (server, routing, auth) should use classes that encapsulate related logic, not loose functions scattered across files.
- **TypeDoc comments** — use TypeDoc-style doc comments but avoid `@` tags (`@param`, `@returns`, `@module`, `@example`). Write natural prose descriptions instead.
- **Config** — API configuration lives in `src/config.json`. Bun imports JSON directly.
- **Shared types** — import Zod schemas and inferred types from `@findr/types`, never from local files. When adding a new entity, define its Zod schema in `packages/types/src/` and re-export from the package index.
- **API routes** — Use `factory()`, never export raw Route literals, never set a `path` property. Use `folder/[...index].ts` for catch-all routes within a directory. For body validation, use `MethodConfig` objects (`{ handler, body? }`) instead of bare handlers — access the parsed body via `c.get("body")`.
- **Pagination** — never fetch large collections without pagination. Bulk/list endpoints must always support and enforce pagination with server-side limits.
- **Validation** — all data validation lives in Zod schemas (`@findr/types`), enforced at the API boundary via `validateBody`.
