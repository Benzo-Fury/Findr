# External services

Findr needs two services beside it: **Prowlarr** to search indexers and **qBittorrent** to download. This folder runs both with Docker Compose, plus **FlareSolverr** as an optional helper for indexers behind Cloudflare. Findr itself runs on the host (`bun run dev`, `bun run start` or the `findr` binary).

| Service | Image | Port | Purpose |
|---|---|---|---|
| Prowlarr | [`lscr.io/linuxserver/prowlarr`](https://docs.linuxserver.io/images/docker-prowlarr/) | 9696 (localhost only) | Indexer manager; Findr calls its search API |
| qBittorrent | [`lscr.io/linuxserver/qbittorrent`](https://docs.linuxserver.io/images/docker-qbittorrent/) | 8080 (localhost only), 6881 tcp/udp | Torrent client; Findr drives its Web API |
| FlareSolverr *(optional)* | [`ghcr.io/flaresolverr/flaresolverr`](https://github.com/FlareSolverr/FlareSolverr) | internal only | Cloudflare challenge solver used by Prowlarr |

## Files

| File | Committed | What it is |
|---|---|---|
| `compose.example.yml` | Yes | The stack, configured entirely from `.env` |
| `.env.example` | Yes | Every variable, with placeholders |
| `compose.yml`, `.env` | No (gitignored) | Your copies |
| `config/` | No (gitignored) | Container state: Prowlarr's database, qBittorrent's settings |

## Setup

### 1. Create your copies

```bash
cd docker
cp compose.example.yml compose.yml
cp .env.example .env
```

Edit `.env`:

- `PUID` / `PGID` — the output of `id -u` and `id -g`, so files the containers write belong to you.
- `TZ` — your timezone, e.g. `Europe/London`.
- `PROWLARR_API_KEY` — any 32-character hex string (`openssl rand -hex 16`). The compose file passes it to Prowlarr as `PROWLARR__AUTH__APIKEY`, which overrides the key Prowlarr would otherwise generate, so Findr and Prowlarr agree from the first start.
- `FINDR_DOWNLOADS_DIR` — an absolute path for Findr's download scratch space (see [why paths matter](#why-the-downloads-folder-is-mounted-at-the-same-path)). Create the folder first.

### 2. Start

```bash
docker compose up -d                          # Prowlarr + qBittorrent
docker compose --profile flaresolverr up -d   # ...and FlareSolverr
docker compose ps
```

### 3. qBittorrent

On first start qBittorrent has user `admin` and a random temporary password that changes on every restart until you set your own:

```bash
docker logs findr-qbittorrent 2>&1 | grep -i password
```

Open http://localhost:8080, sign in, and in **Tools → Options → Web UI** set a username and password. Those are Findr's `QBT_USERNAME` / `QBT_PASSWORD`. Optionally set **Downloads → Default Save Path** to `FINDR_DOWNLOADS_DIR` so torrents you add by hand also land on the mounted folder; Findr always passes its own path.

### 4. Prowlarr

Open http://localhost:9696. On first visit Prowlarr asks you to choose an authentication method for its web UI; pick **Forms** and set a login. This doesn't affect Findr, which uses the API key.

Then add indexers under **Indexers → Add Indexer**. Findr searches every enabled indexer. [Internet Archive](https://archive.org) is a good first one to confirm everything works, since it's public and its content is legal to download. Note that it reports every torrent as 1 seeder (archive.org serves them over HTTP), so Findr's default minimum of 5 seeders rejects them all; lower **Settings → Release preferences → Minimum seeders** while testing with it.

If you started FlareSolverr and an indexer needs it:

1. **Settings → Indexers → Add → FlareSolverr**, host `http://flaresolverr:8191/`, and give it a tag such as `flaresolverr`.
2. Add the same tag to each indexer that sits behind Cloudflare. Untagged indexers don't use it.

### 5. Point Findr at them

In `apps/api/.env` (or the `.env` beside the `findr` binary):

```env
PROWLARR_URL=http://localhost:9696
PROWLARR_API_KEY=<same as docker/.env>
QBT_URL=http://localhost:8080
QBT_USERNAME=<set in step 3>
QBT_PASSWORD=<set in step 3>
```

Start Findr, sign in as the admin, and on **Settings → Paths** set **Downloads** to exactly `FINDR_DOWNLOADS_DIR`. Movies and TV can be anywhere Findr can write; qBittorrent never touches them.

## Why the downloads folder is mounted at the same path

Findr tells qBittorrent where to save each attempt (`<downloads>/<download id>/<release id>/payload`), then reads, remuxes and deletes those files itself. Both see the same paths only if the folder is mounted into the container at its host path, which is what `${FINDR_DOWNLOADS_DIR}:${FINDR_DOWNLOADS_DIR}` does. Mounting it anywhere else (the usual `/downloads`) makes qBittorrent save files where Findr can't find them.

On macOS with Docker Desktop, the folder must be under a shared location (`/Users` is shared by default).

## Everyday use

```bash
docker compose logs -f qbittorrent    # follow a service's logs
docker compose pull && docker compose up -d   # update images
docker compose down                   # stop (state in config/ is kept)
```

To pin versions, set `PROWLARR_TAG`, `QBITTORRENT_TAG` and `FLARESOLVERR_TAG` in `.env` to specific tags.

## Notes

- **Web UIs are bound to 127.0.0.1** so only this machine can reach them. If Findr runs on another host, set `BIND_ADDRESS=0.0.0.0` and put the services behind a firewall or VPN.
- **The torrenting port (6881)** is published on all interfaces so peers can connect. Forward it on your router for better speeds.
- **Prowlarr's download links** point at the address Findr used to search (`PROWLARR_URL`). Findr fetches `.torrent` files itself and uploads them to qBittorrent, so qBittorrent never needs to reach Prowlarr.
- **Findr doesn't seed.** It removes each torrent when the attempt ends.
