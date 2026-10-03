# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
bun run dev              # API (port 34571, restarts on change) and Vite (port 5173) together
bun run dev:api          # API only; proxies non-API requests to Vite
bun run dev:web          # Vite only

# Build & production
bun run build            # Web → API bundle → compiled binary, all into dist/
bun run build --target linux-x64   # cross-compile dist/findr-linux-x64 (repeatable)
bun run start            # Run dist/index.js (serves API + web on PORT)
./dist/findr             # Or run the standalone executable

# Tests (bun test; a preload pins the database to :memory:)
cd apps/api && bun test

# Type checking — generate the build maps first on a fresh checkout
cd apps/api && bun run scripts/cartographer.ts && bun run scripts/assetmap.ts --allow-empty && bunx tsc --noEmit
cd apps/web && bunx tsc -b
```

The Sterilizer and pipeline tests need `mkvmerge` and `ffmpeg` on PATH and are skipped without them.

**Default login:** a database with no users is seeded with one admin, `admin` / `admin` (stored as `admin@findr.local`, flagged `mustReset`). It must replace its email and password on first sign-in before anything else works, so a dev database you have already set up will not accept `admin` / `admin`. To reset one, stop the API, delete the rows from `user`, `account`, `session` and `verification` in `data/findr.db` (the repo-root `data/`), and restart the API — hot reload does not re-run `seedRoot`. There is no env-seeded admin.

Prowlarr (and optional FlareSolverr) run from `docker/`: `compose.example.yml` and `.env.example` are committed; `compose.yml`, `.env` and `config/` are personal and gitignored. Setup steps are in `docker/README.md`. Torrents need no external service — Findr embeds WebTorrent.

## What Findr does

A self-hosted downloader for movies and TV seasons. A request is a TMDB id (plus a season for shows); Findr then:

1. **Searches** Prowlarr, **parses** every release title, **scores** it against hard filters and weights, and optionally **screens** the best with Claude for wrong-title matches. All results, rejected ones included, are stored as candidates.
2. **Attempts** the best pending candidate: the built-in WebTorrent client fetches the file list only, the list is **inspected** (executables, archive-only, incomplete packs are rejected), the chosen files **download** under a watchdog, **mkvmerge** strips everything but video and audio, and the result is **saved** atomically into the library.
3. On a bad release it **rejects** that candidate with the reason, cleans up, and tries the next — up to `queue.maxAttempts`. Seasons try a complete pack first, then fall back to one unit per aired episode; mixed outcomes end as `partial`.

## Architecture

Bun monorepo: `apps/api` (Hono on Bun), `apps/web` (React 19 + react-router-dom + Vite + Tailwind), and shared `packages/`.

### Packages

- `@findr/types` — Zod schemas and inferred types shared by API and web. Import by subpath (`@findr/types/downloads`, `/settings`, `/account`, `/release`, `/media`); new modules get their own file, not a re-export from the index.
- `@findr/config` — code-level constants (`@findr/config/scoring`: the rank tables the scorer scales; the weights themselves are the `scoring` settings section).

### API (`apps/api/src`)

- **Routing** — each file in `routes/` exports one `factory()` Route; the URL is derived from its path under `/api/` (`downloads/[id]/cancel.ts` → `/api/downloads/:id/cancel`, `downloads/index.ts` → `/api/downloads`). Methods are bare handlers or `MethodConfig` (`{ handler, body?, query? }`); read validated input with `bodyOf(c, Schema)` / `queryOf(c, Schema)` from `lib/routing/input.ts`.
- **Route options** — `authenticated` (default **true**), `admin` (admins only), `allowPendingReset` (lets in an account that still has to replace its initial credentials), `rateLimit` (default 600/min; public routes use `PUBLIC_RATE_LIMIT` or their own). `Server.constructRoutes` runs `requireLocal` on every request, then builds each chain: rate limit → auth → pending-reset block → admin → query/body validation → middleware → handler.
- **Auth** — BetterAuth (email + password, `admin` plugin) on the shared SQLite connection. Sign-up is disabled. A fresh install seeds one admin (`seedRoot`) stored as `admin@findr.local` with password `admin`; a BetterAuth before-hook maps the bare `admin` login onto that address. It carries the `mustReset` user field, and until `POST /api/account/credentials` replaces its email and password, every other route and BetterAuth endpoint refuses it with `reset_required`. Admins create further accounts through the admin plugin.
- **Remote access** — `requireLocal` refuses anything not from loopback unless the `access.allowRemote` setting is on (only reachable after the reset). `ClientAddress` decides: the socket must be loopback, and forwarding headers from a local proxy count as remote unless `TRUST_PROXY` is set and the forwarded client is loopback.
- **Database** — raw `bun:sqlite` (`lib/db/client.ts`). Schema changes are append-only entries in `lib/db/migrations.ts`, applied by `Migrator` using `PRAGMA user_version`. BetterAuth migrates its own tables.
- **Models** (`lib/db/models/`) — the only code that writes SQL. Static finders return class instances with typed camelCase fields and mutation methods; instances serialise to `@findr/types` records (`toSummary()`, `toRecord()`, `toDetail()`). Tables: `titles`, `downloads`, `episodes`, `candidates`, `attempts`, `settings`, `app_state` (internal state such as DHT nodes).
- **Configuration** — no `.env` is required. Optional deployment overrides (database path, mkvmerge path, `TRUST_PROXY`, a `PORT` escape hatch) come from the environment, validated in `lib/env/Env.ts`. The BetterAuth secret is generated on first run into `auth.secret` beside the database (`lib/auth/AuthSecret.ts`, owner-only file, deliberately not in the database that holds the session tokens). The port (default 34571) and an optional public URL are `access` settings read once at startup by `lib/server/ServerAddress.ts`, which derives BetterAuth's base URL and trusted origins (localhost, the public URL, and same-origin requests to a bare IP — never an arbitrary hostname, which would open DNS rebinding). Everything else lives in the database (`SettingsStore`, schema in `@findr/types/settings`) and is edited on the web Settings page: paths, naming, preferences, scoring weights, queue, watchdog, wrong-title filter, service URLs and API keys, ports and remote access. Hot paths read one section with `SettingsStore.section()`. There is no JSON config file.
- **Pipeline** (`lib/pipeline/`)
  - `DownloadQueue` — singleton owning enqueue/cancel/retry/delete, concurrency, and startup `recover()` (closes interrupted attempts, rejects their candidates, deletes their scratch dirs, sweeps leftover torrents, resumes unfinished downloads).
  - `DownloadRunner` — one download: movie unit, or season pack then per-episode units; the attempt loop.
  - `CandidateSearch` — Prowlarr → `ReleaseParser` → `ReleaseScorer` → `RelevanceFilter` → persisted candidates.
  - `AttemptRunner` — one candidate: `TorrentSession` → `Sterilizer` → `LibrarySaver`, always cleaning up (each cleanup step time-limited).
  - `Heartbeat` — fails an attempt whose current step shows no sign of life (torrent poll answering, mkvmerge progress, bytes copied) for `watchdog.stuckTimeoutMinutes`, and races the work so even a never-settling promise is escaped. Slow torrents still beat; judging them is `Watchdog`'s job.
  - `errors.ts` — `AttemptFailure` (reject this release, try the next), `FatalDownloadError` (environment broken; don't blame the release), `CancelledError`.
- **Downloader** (`lib/downloader/`) — `Downloader` interface with `WebTorrentDownloader` (in-process client, uTP off, block requests gated until files are chosen, DHT nodes kept in `app_state`); `FileInspector` (safety and file selection), `Watchdog` (metadata/stall/speed), `TorrentSession`, `AttemptWorkspace` (`<downloads>/<downloadId>/<candidateId>/`).
- **VPN killswitch** (`lib/vpn/`, documented in `docs/VPN.md`) — optional (`vpn` settings section), failing closed. `VpnSockets` wraps `net.connect`/`createServer` and `dgram.createSocket` process-wide so every torrent socket binds to the address `VpnGuard.binding()` returns, re-resolved per socket; HTTP trackers, web seeds and `xs` fetches are turned off because `fetch` can't be bound. `VpnGuard` checks the interface, that IPv4/IPv6 routes go through it (UDP-connect probes, re-run on `route -n monitor` / `ip monitor` events and every second) and optionally the public IP. When it trips, `DownloadQueue` calls `Downloader.disconnect()` (destroys the WebTorrent client); transfers then throw `SuspendedError`, which releases the candidate and leaves the download queued until the VPN is back. The client is also rebuilt when the killswitch turns on or the VPN's address changes.
- **Updates** (`lib/updates/Updater.ts`) — asks the GitHub releases API (`UPDATES_URL`) at startup and every six hours, conditionally on the last ETag, remembering the answer in `app_state`. The running version is inlined by the build as `process.env.FINDR_VERSION` (the release workflow passes the tag; otherwise the root `package.json`'s, which is also the fallback when running from source), so `package.json` need not be bumped for a release. The build also inlines `process.env.FINDR_TARGET` (e.g. `darwin-arm64`) into each compiled executable, and its absence means a source checkout, which is only notified. A container (`lib/env/Container.ts`: `FINDR_CONTAINER`, else `/.dockerenv` or `/run/.containerenv`) is only notified too, even when compiled: the image is pulled anew instead. A binary install downloads `findr-<target>` beside itself, checks `SHA256SUMS.txt`, renames it over `process.execPath` and restarts (a detached replacement, or exit 75 under systemd). It is refused while `DownloadQueue.busy`, and holds the queue while it runs. `updates.autoInstall` installs on the first tick (every minute) the queue is empty; a version that failed is not retried automatically. `/api/updates` is open to every user; `check` and `install` are admin-only.
- **Media** (`lib/media/`) — `Sterilizer` (mkvmerge, video + audio only) and `LibrarySaver` (naming templates, atomic temp-name-then-rename placement).
- **Prowlarr** (`lib/prowlarr/Prowlarr.ts`) — search, plus link handling: API keys are stripped into `prowlarr:` references before storage and re-attached only when fetching from the configured Prowlarr URL.
- **TMDB** (`lib/tmdb/`) — cached client behind the `/api/tmdb/*` proxy routes (curated lists and the discover feed, search, details, `genres`, genre `browse`, and batched `cards` that let the web app resolve a whole library cheaply), plus `titleFacts` / `seasonEpisodes` for the pipeline.

### Build & compile

`scripts/build.ts` orchestrates: Vite builds the web app into `apps/web/dist/`, then `apps/api/scripts/build.ts` runs:

1. **Cartographer** (`scripts/cartographer.ts`) — writes `src/_route.map.ts`, statically importing every route so the bundler sees them.
2. **Asset map** (`scripts/assetmap.ts`) — writes `src/_asset.map.ts`, importing every web file with `with { type: "file" }` so it ships with the build.
3. `Bun.build` → `dist/index.js` (+ `dist/web/` assets), then `Bun.build` with `compile` → `dist/findr` (or `dist/findr-<target>` per `--target`, e.g. `bun run build --target linux-arm64`).

WebTorrent's optional native addons (`webrtc-polyfill`, `utp-native`, `fs-native-extensions`) are replaced with pure-JS stubs from `scripts/native-stubs.ts` — by a `Bun.build` plugin in the build, and by a runtime plugin (`scripts/preload.ts`, wired in `bunfig.toml`) in `bun run` and `bun test`. Keep the build free of native code so it cross-compiles; never enable uTP, whose native module crashes Bun.

Both generated files are gitignored. In production the server imports them; in development it globs `routes/` and proxies to Vite instead. Anything new that must ship — routes, assets — has to reach the bundle through static imports; no runtime filesystem discovery in production code paths.

### Web (`apps/web/src`)

Pages in `pages/` (Library, Discover, Downloads, Settings, plus sign-in and first-run credentials), routed in `App.tsx`; every signed-in page sits in `components/shell/app-shell.tsx` (top bar, phone tab bar, ⌘K search palette, and the title sheet any page opens through `?t=movie:603`). `lib/api.ts` is the only place URLs are written; request/response types come from `@findr/types`. `lib/library.tsx` (`LibraryProvider`) holds the whole library in memory and polls active downloads; `lib/title-cards.ts` resolves titles to TMDB cards in batches and keeps them in browser storage. Status labels, icons and tones live in `lib/download-status.ts`; formatting in `lib/format.ts`; text matching in `lib/search.ts`; motion presets in `lib/motion.ts`; paging and polling hooks in `lib/hooks.ts`.

UI: light theme only. Design tokens (colours, type, radii, shadows, easings) are defined once in `index.css` `@theme`; the brand amber `signal` is the single accent and is never used as text on paper (use `signal-ink`). Fonts: Bricolage Grotesque (display, self-hosted with all axes in `src/assets/fonts/`), Geist, Geist Mono. Shape rule: controls are pills, artwork is `rounded-art`, panels and sheets are `rounded-panel`. Icons are Phosphor (`*Icon` exports) only. Primitives live in `components/ui/` (Base UI for dialogs, menus and switches; Motion for animation, wrapped in `MotionConfig reducedMotion="user"`); feature components in `components/{shell,title,media,discover,downloads,settings,updates}/`. `lib/updates.ts` (`useUpdates`) loads the update status and drives an install, polling through the restart and reloading once a new version answers; `components/updates/update-banner.tsx` shows it on Library and Settings. Settings are declared once in `components/settings/registry.ts`, which drives rendering, search and validation.

## Conventions

- **Object-oriented systems** — major systems are classes that group related state and behaviour, not loose functions.
- **TypeDoc comments** — doc comments on every declaration in natural prose, no `@` tags. Brief inline comments head each block of logic.
- **Strict TypeScript** — no `any`; typed boundaries via `@findr/types`.
- **No barrel files** — import from the source module (packages use subpath exports).
- **Models own SQL** — nothing outside `lib/db/models/` builds queries.
- **Validation** — Zod schemas in `@findr/types`, enforced at the API boundary by `validateBody` / `validateQuery`.
- **Pagination** — list endpoints take `page` / `pageSize` and cap page size server-side (`MAX_PAGE_SIZE`), returning `Paginated<T>`.
- **Secrets** — API keys are stored in the `services` settings section but never sent to the client: the settings response blanks every field in `SECRET_FIELDS` and reports only whether each is set. Candidate records exclude download links entirely.
- **Library writes** — only through `LibrarySaver`, which never exposes a partial file.
- **Errors** — API errors are `{ error: "<snake_case_code>" }`; the web maps codes to messages in `lib/api.ts`.
- **Commits** — conventional commit messages.
