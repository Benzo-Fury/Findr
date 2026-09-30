# Configuration

Findr has two kinds of configuration, stored in two places:

| Kind | Where | Changed by | Examples |
|---|---|---|---|
| **Deployment** — how and where the server runs, and every secret | Environment variables (`.env`) | Whoever runs the server; needs a restart | Port, database file, API keys, service URLs |
| **Settings** — how Findr searches, downloads and saves | The database, edited on the **Settings** page | Admins, in the browser; applies to the next download | Library paths, naming, release preferences, watchdog |

There is no config file. Secrets never go in the database, and nothing the browser can edit can point Findr at an executable.

---

## Environment variables

Bun reads `.env` from the working directory automatically — in development that is `apps/api/.env`; for the compiled `findr` binary it is the directory you run it from. A starting point is in [`apps/api/.env.example`](../apps/api/.env.example).

Startup fails with a list of problems if anything required is missing or malformed.

### Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `production` in builds. In development the API proxies the web app to Vite and trusts `http://localhost:5173` for auth. |
| `PORT` | No | `3030` | Port for the API and web app. |
| `DATABASE_PATH` | No | `findr.db` | SQLite file. Relative paths resolve from the repo root in development, and from the working directory for the compiled binary. |
| `BASE_URL` | **Yes** | — | Public URL of the server, e.g. `http://localhost:3030`. Used by BetterAuth for cookies and redirects. |
| `BETTER_AUTH_SECRET` | **Yes** | — | Session signing secret. Generate with `openssl rand -hex 32`. |
| `TRUST_PROXY` | No | `false` | Use the first `X-Forwarded-For` address for rate limiting. Only enable behind a reverse proxy you control. |

### First admin

Sign-up is disabled. On startup, if the database has no users, Findr creates an admin from these. Once any account exists they are ignored and can be removed. Further accounts are created on the Settings page.

| Variable | Required | Description |
|---|---|---|
| `FINDR_ADMIN_EMAIL` | On first run | Email for the first admin account. |
| `FINDR_ADMIN_PASSWORD` | On first run | Password for the first admin account. |

### Services

| Variable | Required | Default | Description |
|---|---|---|---|
| `TMDB_API_KEY` | **Yes** | — | [TMDB](https://developer.themoviedb.org/) API key, for browsing, metadata, episode lists and naming. |
| `PROWLARR_URL` | **Yes** | — | Base URL of your [Prowlarr](https://prowlarr.com/) instance, e.g. `http://localhost:9696`. |
| `PROWLARR_API_KEY` | **Yes** | — | Prowlarr API key (Settings → General). Never stored in the database or sent to the browser: Prowlarr's download links are saved with the key removed, and it is re-attached only when Findr fetches from this URL. |
| `QBT_URL` | No | `http://localhost:8080` | qBittorrent Web UI URL. qBittorrent must see the same filesystem paths as Findr. |
| `QBT_USERNAME` | Yes* | — | qBittorrent Web UI username. *Unless qBittorrent bypasses auth for Findr's address. |
| `QBT_PASSWORD` | Yes* | — | qBittorrent Web UI password. |
| `MKVMERGE_PATH` | No | `mkvmerge` | mkvmerge binary, from [MKVToolNix](https://mkvtoolnix.download/). An env var on purpose — an executable path should not be editable from a browser. |
| `ANTHROPIC_API_KEY` | No | — | Enables the wrong-title filter (see below). Without it the filter is skipped. |

---

## Settings

Admins edit these on the **Settings** page; they are stored in the database and read at the start of each unit of work, so changes apply to the next download without a restart. Every setting has a default, so a fresh install works once the paths are set.

The same data is available at `GET /api/settings` and `PATCH /api/settings` (admins only; a patch may contain any subset of fields and is validated as a whole before anything is saved).

### Library paths — `paths`

Absolute paths on the server. They must be set before the first download.

| Field | Description |
|---|---|
| `downloads` | Scratch space. Each attempt gets its own folder, `downloads/<download id>/<release id>/`, deleted when the attempt ends however it ends. |
| `movies` | Library root for movies, e.g. your Jellyfin or Plex movies folder. |
| `series` | Library root for shows. |

Files are placed atomically: they are written under a hidden temporary name inside the destination folder and renamed into place, so the library never contains a half-written file — even across filesystems or if Findr is killed mid-copy.

### Naming — `naming`

Templates using `{title}`, `{year}`, `{season}` and `{episode}`. Titles and years come from TMDB; seasons and episodes are zero-padded. `.mkv` is always appended. Characters illegal on macOS, Linux or Windows are removed, and empty `()` from a missing year are dropped.

| Field | Default | Example |
|---|---|---|
| `movieFolder` | `{title} ({year})` | `Interstellar (2014)/` |
| `movieFile` | `{title} ({year})` | `Interstellar (2014).mkv` |
| `seriesFolder` | `{title} ({year})` | `Breaking Bad (2008)/` |
| `seasonFolder` | `Season {season}` | `Season 01/` |
| `seriesFile` | `{title} - S{season}E{episode}` | `Breaking Bad - S01E01.mkv` |

A file holding several episodes is named with a range, e.g. `S01E01-E02`.

### Release preferences — `preferences`

| Field | Default | Description |
|---|---|---|
| `resolutions` | `1080p, 720p, 2160p` | Preferred resolutions, best first. Unlisted resolutions score nothing for resolution but are not rejected. Options: `480p`, `720p`, `1080p`, `2160p`. |
| `maxFileSizeGB` | `10` | Largest allowed size per movie or per episode. Season packs are judged per episode. |
| `minSeeders` | `5` | Releases with fewer seeders are rejected. |
| `blacklistedReleaseTypes` | `CAM, TS, SCR` | Release types never downloaded. |

Scoring weights themselves (how much resolution, codec, size, seeders and so on count) are in [`packages/config/src/scoring.ts`](../packages/config/src/scoring.ts).

### Queue — `queue`

| Field | Default | Description |
|---|---|---|
| `maxConcurrent` | `2` | Downloads running at once. |
| `maxAttempts` | `5` | Failed attempts allowed per unit of work — the movie, the season pack, or each episode — in one run before that unit gives up. Attempts cut short by a restart or by an unavailable service do not count. |

### Download watchdog — `watchdog`

A torrent that trips any of these is abandoned, its files deleted, and the next release tried.

| Field | Default | Description |
|---|---|---|
| `metadataTimeoutMinutes` | `5` | How long a magnet may take to produce its file list. |
| `stallTimeoutMinutes` | `10` | How long a download may go without receiving any new data. |
| `minSpeedKBps` | `50` | Average speed floor, judged over a full `speedWindowMinutes`. `0` disables it. |
| `speedWindowMinutes` | `10` | The window the average speed is measured over. |
| `pollIntervalSeconds` | `5` | How often progress is checked. |

### Wrong-title filter — `llmFilter`

An optional pass that asks Claude which of the best-scoring releases are clearly for a different title — a remake, sequel, spin-off or similarly named film — and drops them before anything downloads. It only runs when `ANTHROPIC_API_KEY` is set. It **fails open**: on any error, refusal or timeout every release is kept, so it can never block a download.

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Turn the filter on or off. |
| `model` | `claude-haiku-4-5` | Claude model used. |
| `maxCandidates` | `20` | How many of the top-scoring releases are screened. |
| `timeoutSeconds` | `20` | Request timeout. |

---

## What gets rejected, and when

For reference, every check a release goes through, in order:

1. **Search** — Prowlarr results are de-duplicated (the same torrent from several indexers counts once).
2. **Hard filters** — wrong structure (a TV release for a movie, a single episode for a season, a multi-season pack), blacklisted type, too few seeders, over the size limit, or a movie from a different year. Rejected with the reason; never downloaded.
3. **Wrong-title filter** — optional, see above.
4. **File inspection** — after the torrent's file list arrives but *before any payload downloads*: any executable or script (`.exe`, `.scr`, `.lnk`, `.bat`, `.cmd`, `.ps1`, `.msi`, `.js`, …) rejects the whole torrent, as does an archive-only release or one with no full-length video. Season packs must contain every aired episode. Only the needed video files are downloaded.
5. **Watchdog** — while downloading, see above.
6. **Sterilize** — mkvmerge rejects unreadable containers and files without a video stream.
