<div align="center">
  <img src="/apps/web/public/findr-banner-rounded.png" width="900px"/>
  <h1>Find. Anything.</h1>
  <h4>Automated torrent downloader for movies and tv shows.</h4>
</div>

## What is this?

Findr is a standalone, self hosted, web app for automatically downloading tv shows and movies via torrents. It automatically handles finding torrents, picking the best one, downloading it, and sterilizing it all from a movie or tv series name.

> [!NOTE]
> Using Findr, you COULD watch any movie or TV series produced ever, while paying nothing 🤑.

> [!WARNING]
> The use of Findr may be **ILLEGAL** in your country or jurisdiction. Read our [disclaimer](#disclaimer) before using the project.

<img src="/apps/web/public/ui-example-1.png" width="900px"/>
<img src="/apps/web/public/ui-example-2.png" width="900px"/>
<img src="/apps/web/public/ui-example-3.png" width="900px"/>

## Features

- 🔍 **Auto Search & Download** - Find and download movies or series from just a name
- 🏆 **Smart Torrent Ranking** - Scores torrents on resolution, codec, seeders, release type, file size, and uploader reputation to auto-pick the best one
- 🛡️ **Download Sterilization** - Re-encodes all downloads to strip metadata and neutralize embedded threats
- ⚡ **Hardware-Accelerated Encoding** - Auto-detects the best available encoder on your system (VideoToolbox, NVENC, QSV, VA-API, and more)
- 📺 **Plex-Ready** - Organizes your library with proper naming and folder structure, plug directly into Plex (or any self hosted video service for that matter) with minimal setup

## How It Works

Give Findr a movie or series name and it handles the rest. Every request flows through a four-stage pipeline:

```mermaid
graph LR
    A["🔍 Search"] --> B["🏆 Rank"]
    B --> C["🛡️ Sterilize"]
    C --> D["💾 Save"]
```

| Stage         | What happens                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Search**    | Queries torrent indexers (YTS, EZTV, TheRARBG) in parallel                                                              |
| **Rank**      | Scores results on resolution, codec, seeders, release type, file size, and uploader reputation, then picks the best one |
| **Sterilize** | Downloads via qBittorrent, re-encodes through ffmpeg to strip metadata and produce clean H.264/AAC output               |
| **Save**      | Fetches proper title and year from TMDB, renames using your naming templates, moves to your library                     |

The pipeline is managed by a job queue that supports concurrent jobs and automatically resumes incomplete work after a restart.

## Installation & Setup

### 📋 Prerequisites

You'll need the following installed on your system before setting up Findr:

| Dependency                                         | Purpose                                          |
| -------------------------------------------------- | ------------------------------------------------ |
| [Bun](https://bun.sh)                              | JavaScript runtime & package manager             |
| [Rust/Cargo](https://rustup.rs)                    | Compiles the `therarbg-cli` torrent scraper      |
| [PostgreSQL](https://www.postgresql.org/download/) | Database for jobs, indexes, and auth             |
| [qBittorrent](https://www.qbittorrent.org/)        | Torrent download client (Web UI must be enabled) |
| [ffmpeg](https://ffmpeg.org/download.html)         | Video re-encoding & sterilization                |
| [TMDB API Key](https://developer.themoviedb.org/)  | Movie & TV metadata (free to register)           |

### 🚀 Setup

**1. Clone the repo**

```bash
git clone https://github.com/Benzo_Neo/Findr.git
cd Findr
bun install
```

**2. Configure environment variables**

Create `apps/api/.env`:

```env
NODE_ENV=development
DATABASE_URL=postgres://localhost:5432/findr
BETTER_AUTH_SECRET=<generate-a-secure-random-string>
BASE_URL=http://localhost:3030
TMDB_API_KEY=<your-tmdb-api-key>
QBT_PORT=8080
QBT_USERNAME=<your-qbittorrent-username>
QBT_PASSWORD=<your-qbittorrent-password>
```

Create `apps/web/.env`:

```env
VITE_TMDB_API_KEY=<your-tmdb-api-key>
```

**3. Configure paths**

Edit `apps/api/src/config.json` and set the directory paths for your system:

```json
{
  "paths": {
    "logs": "/path/to/logs",
    "download": "/path/to/temp/downloads",
    "movies": "/path/to/plex/movies",
    "series": "/path/to/plex/tv",
    "ffmpeg": "ffmpeg"
  }
}
```

> [!NOTE]
> All directories must exist before starting Findr. The `download` path is temporary storage during sterilization. Finished files are moved to `movies` or `series`.

**4. Initialize the database**

Create a PostgreSQL database called `findr`, then push the schema:

```bash
createdb findr
bun db:push
```

**5. Enable qBittorrent Web UI**

Open qBittorrent → Preferences → Web UI:

- Enable the Web UI
- Set the port to match `QBT_PORT` (default `8080`)
- Set a username and password matching your `.env`

**6. Start Findr**

```bash
# Development (hot reload)
bun run dev

# Production
bun run build
bun run start
```

Findr runs on `http://localhost:3030`. The API and web UI are served from the same port.

## Sterilization

Videos downloaded from the Bittorrent network notoriously contain malware. Findr combats this 2 ways:

1. **Reputable Sources** - Findr only get's its sources from reputable services.
2. **FFMPEG Re-Encoding** - Findr runs FFMPEG over all downloaded video files, reducing the attack vector for malware (see [Video Re-Encoding](/docs/Video_Re-Encoding.md)).

> [!NOTE]
> Any other files that may have been downloaded (such as subtitles, cover photos, malware, etc) are deleted.

## Disclaimer

Findr is provided strictly for **educational and personal use**. The developers of Findr do not host, distribute, or index any copyrighted content. Findr is a tool that interacts with publicly available torrent indexers and the BitTorrent protocol. What you do with it is your responsibility.

Downloading copyrighted material without permission may be **illegal** in your country or jurisdiction. By using Findr, you acknowledge that:

- You are solely responsible for ensuring your use complies with all applicable local, state, and federal laws
- The developers assume no liability for any misuse of this software or any legal consequences that may arise from its use
- Findr was developed and tested exclusively using content uploaded by the developers themselves

**If you are unsure whether using Findr is legal where you live, do not use it.**
