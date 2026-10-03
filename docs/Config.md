# Configuration

Findr has two kinds of configuration, stored in two places:

| Kind | Where | Changed by | Examples |
|---|---|---|---|
| **Deployment** - how and where the server runs | Environment variables (`.env`), all optional | Whoever runs the server; needs a restart | Database file, mkvmerge path, proxy trust, port override |
| **Settings** - everything else | The database, edited on the **Settings** page | Admins, in the browser; most apply to the next download | Service URLs and API keys, library paths, naming, release preferences, scoring, watchdog, VPN killswitch, remote access |

There is no config file. API keys are stored in the database but never sent back to the browser, and nothing the browser can edit can point Findr at an executable.

---

## Environment variables

Bun reads `.env` from the working directory automatically - in development that is `apps/api/.env`; for the compiled `findr` binary it is the directory you run it from. A starting point is in [`apps/api/.env.example`](../apps/api/.env.example).

None is required, so Findr starts without a `.env`. Startup fails with a list of problems if a variable is malformed.

### Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `production` in builds. In development the API proxies the web app to Vite and trusts `http://localhost:5173` for auth. |
| `PORT` | No | - | Overrides the port set under [Access](#access--access). Leave it unset; it is the way back in when the configured port is taken. |
| `DATABASE_PATH` | No | `data/findr.db` | SQLite file (the folder is created on first run). Relative paths resolve from the repo root in development, and from the working directory for the compiled binary. |
| `TRUST_PROXY` | No | `false` | Believe the first `X-Forwarded-For` address, for rate limiting and for the remote access check. Only enable behind a reverse proxy you control. |
| `MKVMERGE_PATH` | No | `mkvmerge` | mkvmerge binary, from [MKVToolNix](https://mkvtoolnix.download/). An env var on purpose - an executable path should not be editable from a browser. |

---

## Session secret

Findr signs session cookies with a random secret it generates on first run and keeps in `auth.secret`, in the same folder as the database (`data/` by default), readable only by the user Findr runs as. There is nothing to set. Back it up with the database; if it is lost or deleted, a new one is generated and everyone is signed out, but no data is lost.

It is kept out of the database on purpose: the database stores session tokens, and the secret is what stops a token copied out of a leaked database or backup from being used as a cookie.

---

## First sign-in

Sign-up is disabled. When the database has no accounts, Findr creates one admin that signs in as **`admin`** / **`admin`** (it is stored as `admin@findr.local`; typing either works). That account must set its own email and password before it can do anything else - every other page and API call is refused until it does - and doing so signs out any other session that used the old credentials. New passwords must be at least 8 characters.

Because remote access is off by default (see [Access](#access--access)), the first sign-in can only happen from the machine Findr runs on. Further accounts are created on the Settings page.

On a headless VPS with no local browser, reach that first sign-in by forwarding the port over SSH instead of opening Findr to the network: `ssh -L 34571:localhost:34571 user@your-vps`, then open `http://localhost:34571` in a browser on your own machine. The request arrives at Findr from the VPS's own loopback interface, so it is accepted under the default settings - no need to touch `allowRemote` or `TRUST_PROXY` just to get in the door. Once signed in, turn on `allowRemote` (and set `publicUrl` if you'll reach it by name) if you actually want remote access going forward; otherwise keep using the tunnel.

---

## Settings

Admins edit these on the **Settings** page; they are stored in the database and read at the start of each unit of work, so changes apply to the next download without a restart (the torrent port is the exception). Every setting has a default, so a fresh install works once the services and paths are set.

The same data is available at `GET /api/settings` and `PATCH /api/settings` (admins only; a patch may contain any subset of fields and is validated as a whole before anything is saved). API keys are never returned: both answer with them blanked, plus a `configured` map saying which are set.

### Services - `services`

| Field | Description |
|---|---|
| `prowlarrUrl` | Base URL of your [Prowlarr](https://prowlarr.com/) instance, e.g. `http://localhost:9696`. Required. |
| `prowlarrApiKey` | Prowlarr API key (Prowlarr → Settings → General; the Docker setup pins it from `docker/.env`). Required. Prowlarr's download links are saved with the key removed, and it is re-attached only when Findr fetches from this URL. |
| `tmdbApiKey` | [TMDB](https://developer.themoviedb.org/) API key, for browsing, metadata, episode lists and naming. Required. |
| `anthropicApiKey` | Enables the wrong-title filter (see below). Optional; without it the filter is skipped. |

The three keys are secrets: stored in the database, never sent to the browser. On the page a key field shows only whether a key is saved; typing replaces it and **Remove** clears it. Through the API, an empty string clears a key.

### Library paths - `paths`

Absolute paths on the server. They must be set before the first download.

| Field | Description |
|---|---|
| `downloads` | Scratch space. Each attempt gets its own folder, `downloads/<download id>/<release id>/`, deleted when the attempt ends however it ends. |
| `movies` | Library root for movies, e.g. your Jellyfin or Plex movies folder. |
| `series` | Library root for shows. |

Files are placed atomically: they are written under a hidden temporary name inside the destination folder and renamed into place, so the library never contains a half-written file - even across filesystems or if Findr is killed mid-copy.

### Naming - `naming`

Templates using `{title}`, `{year}`, `{season}` and `{episode}`. Titles and years come from TMDB; seasons and episodes are zero-padded. `.mkv` is always appended. Characters illegal on macOS, Linux or Windows are removed, and empty `()` from a missing year are dropped.

| Field | Default | Example |
|---|---|---|
| `movieFolder` | `{title} ({year})` | `Interstellar (2014)/` |
| `movieFile` | `{title} ({year})` | `Interstellar (2014).mkv` |
| `seriesFolder` | `{title} ({year})` | `Breaking Bad (2008)/` |
| `seasonFolder` | `Season {season}` | `Season 01/` |
| `seriesFile` | `{title} - S{season}E{episode}` | `Breaking Bad - S01E01.mkv` |

A file holding several episodes is named with a range, e.g. `S01E01-E02`.

### Release preferences - `preferences`

| Field | Default | Description |
|---|---|---|
| `resolutions` | `1080p, 720p, 2160p` | Preferred resolutions, best first. Unlisted resolutions score nothing for resolution but are not rejected. Options: `480p`, `720p`, `1080p`, `2160p`. |
| `maxFileSizeGB` | `10` | Largest allowed size per movie or per episode. Season packs are judged per episode. |
| `minSeeders` | `5` | Releases with fewer seeders are rejected. |
| `blacklistedReleaseTypes` | `CAM, TS, SCR` | Release types never downloaded. |

### Scoring weights - `scoring`

How much each quality signal counts when ranking releases that passed the hard filters. Each weight is the most that signal can add. The rank tables they scale - which codecs, release types and groups are preferred - are in [`packages/config/src/scoring.ts`](../packages/config/src/scoring.ts).

| Field | Default | Description |
|---|---|---|
| `resolution` | `30` | Scaled by position in your resolution list. |
| `fileSize` | `25` | Peaks at the ideal size; very small or very large files score negatively. |
| `seeders` | `25` | Logarithmic, up to `seederCap`. |
| `codec` | `20` | AV1 over x265 over x264. |
| `releaseType` | `20` | Web and Blu-ray sources over rips. |
| `releaseGroup` | `5` | Full weight for known-good groups, a little for any named group. |
| `uploadDate` | `3` | Newer uploads, fading to nothing over a year. |
| `repack` | `2` | Added to repacks and propers. |
| `idealMovieSizeGB` | `4` | Size per movie that scores best. |
| `idealEpisodeSizeGB` | `1.2` | Size per episode that scores best. |
| `seederCap` | `1000` | Seeders beyond this add nothing. |
| `bloated4KPenalty` | `15` | Subtracted from 2160p releases above `bloated4KSizeGB`. |
| `bloated4KSizeGB` | `20` | Per movie or episode. |

### Queue - `queue`

| Field | Default | Description |
|---|---|---|
| `maxConcurrent` | `2` | Downloads running at once. |
| `maxAttempts` | `5` | Failed attempts allowed per unit of work - the movie, the season pack, or each episode - in one run before that unit gives up. Attempts cut short by a restart or by an unavailable service do not count. |

### Download watchdog - `watchdog`

A torrent that trips any of these is abandoned, its files deleted, and the next release tried. The same happens to an attempt that hangs outright at any step (see `stuckTimeoutMinutes`), and cleanup afterwards is time-limited, so a hung step can never hold up a download or a cancel.

| Field | Default | Description |
|---|---|---|
| `metadataTimeoutMinutes` | `5` | How long a magnet may take to produce its file list. |
| `stallTimeoutMinutes` | `10` | How long a download may go without receiving any new data. |
| `minSpeedKBps` | `50` | Average speed floor, judged over a full `speedWindowMinutes`. `0` disables it. |
| `speedWindowMinutes` | `10` | The window the average speed is measured over. |
| `pollIntervalSeconds` | `5` | How often progress is checked. |
| `stuckTimeoutMinutes` | `10` | How long any step of an attempt - fetching, downloading, sterilizing, saving - may show no sign of life before it counts as stuck. A sign of life is a torrent poll answering (however little arrived), mkvmerge reporting progress, or bytes copied into the library, so a slow or seedless torrent is never caught by this; the checks above handle those. |

### Wrong-title filter - `llmFilter`

An optional pass that asks Claude which of the best-scoring releases are clearly for a different title - a remake, sequel, spin-off or similarly named film - and drops them before anything downloads. It only runs when an Anthropic API key is set under `services`. It **fails open**: on any error, refusal or timeout every release is kept, so it can never block a download.

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Turn the filter on or off. |
| `model` | `claude-haiku-4-5` | Claude model used. |
| `maxCandidates` | `20` | How many of the top-scoring releases are screened. |
| `timeoutSeconds` | `20` | Request timeout. |

### Torrent client - `torrent`

| Field | Default | Description |
|---|---|---|
| `port` | `6881` | Port of the built-in torrent client: TCP for peers, UDP for the DHT. Forward it on your router for better speeds; `0` picks a random free port. Read when the client starts, so a change applies after Findr restarts. |

### VPN killswitch - `vpn`

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Run torrents only through the VPN: every torrent socket is bound to the VPN interface's address, and the client is cut off whenever a check fails. Also turns off HTTP trackers, web seeds, local peer discovery and router port mapping. |
| `interfaceName` | - | The VPN's network interface, such as `wg0` or `tun0`; a trailing `*` matches a prefix (`utun*` on macOS). Required while `enabled`: with it empty, torrents stay blocked. Internet traffic must also be routed through it. |
| `homeIps` | - | Optional. Your home connection's public IPv4/IPv6 addresses, comma separated. When set, the public address is looked up and torrents stop if it is one of these or the lookup fails. |

How each check works, what it can't cover, and how to add a killswitch outside Findr: **[VPN.md](VPN.md)**.

### Access - `access`

| Field | Default | Description |
|---|---|---|
| `port` | `34571` | Port for the web app and API. Read at startup, so a change applies after a restart. The `PORT` environment variable overrides it. |
| `publicUrl` | - | The URL people open Findr at, when that is a hostname rather than `localhost` or an IP - a reverse proxy's URL, or a name like `nas.local`. Read at startup. |
| `allowRemote` | `false` | Answer requests from other machines. While off, Findr serves only requests from the server itself (loopback), the web app included. |

The setting can only be turned on from the Settings page, which the initial `admin` account cannot reach until it has set its own credentials, so a fresh install is never exposed with its default login.

Sign-ins are accepted only from pages served at `http://localhost:<port>`, at `publicUrl`, or at an IP address (how other machines on your network reach Findr). A page at any other hostname is refused even if that name points at the server, which stops a website from rebinding its own domain to your machine and signing in as the initial `admin`. So set `publicUrl` whenever you open Findr by name. An `https` public URL also makes the session cookie `Secure`.

Behind a reverse proxy on the same machine, every request reaches Findr from loopback. Findr treats such forwarded requests as remote unless `TRUST_PROXY` is set, in which case it judges the client named in `X-Forwarded-For`. So with a local proxy, either turn on `allowRemote` or set `TRUST_PROXY`; never set `TRUST_PROXY` without a proxy in front, or any client could claim to be local.

---

## What gets rejected, and when

For reference, every check a release goes through, in order:

1. **Search** - Prowlarr results are de-duplicated (the same torrent from several indexers counts once).
2. **Hard filters** - wrong structure (a TV release for a movie, a single episode for a season, a multi-season pack), blacklisted type, too few seeders, over the size limit, or a movie from a different year. Rejected with the reason; never downloaded.
3. **Wrong-title filter** - optional, see above.
4. **File inspection** - after the torrent's file list arrives but *before any payload downloads*: any executable or script (`.exe`, `.scr`, `.lnk`, `.bat`, `.cmd`, `.ps1`, `.msi`, `.js`, …) rejects the whole torrent, as does an archive-only release or one with no full-length video. Season packs must contain every aired episode. Only the needed video files are downloaded.
5. **Watchdog** - while downloading, see above.
6. **Sterilize** - mkvmerge rejects unreadable containers and files without a video stream.
7. **Stuck** - at any step, an attempt with no sign of life for `stuckTimeoutMinutes` is rejected, see above.
