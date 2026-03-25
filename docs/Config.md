# Configuration

Findr is configured through two mechanisms: a JSON config file for application settings, and environment variables for secrets and service credentials.

## Config File

**Location:** `apps/api/src/config.json`

This file controls paths, port, naming, ffmpeg behaviour, and route defaults. Bun imports it directly at build time.

### `port`

The port the API server listens on. In production, both the API and web UI are served from this port.

```json
"port": 3030
```

### `paths`

Filesystem paths Findr uses for storage and external binaries. All paths must be absolute.

```json
"paths": {
  "logs": "/path/to/logs",
  "download": "/path/to/temp/downloads",
  "movies": "/path/to/library/movies",
  "series": "/path/to/library/tv",
  "ffmpeg": "ffmpeg"
}
```

| Key | Description |
|---|---|
| `logs` | Directory where per-job log files are written. Each job gets its own timestamped log file. |
| `download` | Temporary storage for torrent downloads. Files are held here during download and transcoding, then deleted after being moved to their final destination. |
| `movies` | Final library path for movies. Sterilized movie files are organized here using the naming templates. Point this at your Plex (or equivalent) movies directory. |
| `series` | Final library path for TV series. Same as above, but for series. |
| `ffmpeg` | Path to the ffmpeg binary. Use `"ffmpeg"` if it's in your system PATH, or provide an absolute path to a custom build (e.g. `"/usr/local/bin/ffmpeg-rkmpp"`). |

> [!IMPORTANT]
> All directories (`logs`, `download`, `movies`, `series`) must exist before starting Findr. It will not create them for you.

### `ffmpeg`

Controls how Findr selects and configures the video encoder. See [Video Re-Encoding](/docs/Video_Re-Encoding.md) for a deeper explanation of hardware encoder detection.

```json
"ffmpeg": {
  "disableAutoEncoder": false,
  "extraArgs": []
}
```

| Key | Default | Description |
|---|---|---|
| `disableAutoEncoder` | `false` | When `true`, skips automatic hardware encoder detection entirely. The encoder must then be specified manually via `extraArgs`. When `false`, Findr probes ffmpeg on first transcode and picks the best available hardware encoder. |
| `extraArgs` | `[]` | Additional flags passed to ffmpeg. Behaviour depends on `disableAutoEncoder`: |

**When `disableAutoEncoder` is `false`** (default): `extraArgs` are appended *after* the auto-detected encoder's flags. Useful for adding options like `["-threads", "4"]` without overriding the encoder itself.

**When `disableAutoEncoder` is `true`**: `extraArgs` become the *only* encoder flags. You must include `-c:v <encoder>` and any quality arguments yourself. If `extraArgs` is empty in this mode, Findr falls back to libx264 software encoding.

Example for a Rockchip RK3588 board with a custom ffmpeg build:

```json
"paths": {
  "ffmpeg": "/usr/local/bin/ffmpeg-rkmpp"
},
"ffmpeg": {
  "disableAutoEncoder": true,
  "extraArgs": ["-c:v", "h264_rkmpp", "-rc_mode", "CQP", "-qp_init", "26"]
}
```

### `naming`

Templates that control how files and folders are named when saved to your library. Templates use `{token}` placeholders that are replaced with metadata from TMDB.

```json
"naming": {
  "movieFolder": "{title} ({year})",
  "movieFile": "{title} ({year})",
  "seriesFolder": "{title} ({year})",
  "seasonFolder": "Season {season}",
  "seriesFile": "{title} - S{season}E{episode}"
}
```

| Key | Available tokens | Example output |
|---|---|---|
| `movieFolder` | `{title}`, `{year}` | `Interstellar (2014)/` |
| `movieFile` | `{title}`, `{year}` | `Interstellar (2014).mp4` |
| `seriesFolder` | `{title}`, `{year}` | `Breaking Bad (2008)/` |
| `seasonFolder` | `{season}` | `Season 01/` |
| `seriesFile` | `{title}`, `{year}`, `{season}`, `{episode}` | `Breaking Bad - S01E01.mp4` |

The file extension (`.mp4`) is appended automatically. Don't include it in the template. Characters that are illegal on macOS, Linux, or Windows filesystems are stripped automatically.

If TMDB metadata can't be fetched for a given IMDb ID, files keep their original names and the folder falls back to the raw IMDb ID.

### `routeDefaults`

Default settings applied to every API route unless explicitly overridden by a specific route.

```json
"routeDefaults": {
  "authenticated": false,
  "rateLimit": {
    "max": 60,
    "window": 60
  }
}
```

| Key | Description |
|---|---|
| `authenticated` | Whether routes require authentication by default. Individual routes can override this. |
| `rateLimit.max` | Maximum number of requests allowed within the time window. |
| `rateLimit.window` | Time window in seconds. |

## Environment Variables

Secrets and service credentials are configured via environment variables in `apps/api/.env` and `apps/web/.env`. These are never committed to the repo.

### API (`apps/api/.env`)

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | Set to `development` or `production`. Controls trusted auth origins and console log output. Defaults to `development`. |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Example: `postgres://localhost:5432/findr` |
| `BETTER_AUTH_SECRET` | Yes | Secret key used to encrypt sessions. Generate a long random string (e.g. `openssl rand -hex 32`). |
| `BASE_URL` | Yes | The base URL of the API server, used by BetterAuth for redirects. Example: `http://localhost:3030` |
| `TMDB_API_KEY` | Yes | API key from [TMDB](https://developer.themoviedb.org/). Used to fetch movie/series metadata (titles, years) for naming and library organization. Free to register. |
| `QBT_PORT` | No | Port of the qBittorrent Web UI. Defaults to `8080`. |
| `QBT_USERNAME` | Yes | Username for qBittorrent Web UI authentication. |
| `QBT_PASSWORD` | Yes | Password for qBittorrent Web UI authentication. |

### Web (`apps/web/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_TMDB_API_KEY` | Yes | Same TMDB API key as the API. Used by the frontend to search for movies and TV shows and display poster art. |
