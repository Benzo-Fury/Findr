# External services

Findr downloads torrents with its own built-in client, so the only service it needs beside it is **Prowlarr**, to search your indexers. This folder runs it with Docker Compose, plus **FlareSolverr** as an optional helper for indexers behind Cloudflare. Findr itself runs on the host (`bun run dev`, `bun run start` or the `findr` binary).

| Service | Image | Port | Purpose |
|---|---|---|---|
| Prowlarr | [`lscr.io/linuxserver/prowlarr`](https://docs.linuxserver.io/images/docker-prowlarr/) | 9696 (localhost only) | Indexer manager; Findr calls its search API |
| FlareSolverr *(optional)* | [`ghcr.io/flaresolverr/flaresolverr`](https://github.com/FlareSolverr/FlareSolverr) | internal only | Cloudflare challenge solver used by Prowlarr |

## Files

| File | Committed | What it is |
|---|---|---|
| `compose.example.yml` | Yes | The stack, configured entirely from `.env` |
| `.env.example` | Yes | Every variable, with placeholders |
| `compose.yml`, `.env` | No (gitignored) | Your copies |
| `config/` | No (gitignored) | Container state: Prowlarr's database and settings |

## Setup

### 1. Create your copies

```bash
cd docker
cp compose.example.yml compose.yml
cp .env.example .env
```

Edit `.env`:

- `PUID` / `PGID` - the output of `id -u` and `id -g`, so files the containers write belong to you.
- `TZ` - your timezone, e.g. `Europe/London`.
- `PROWLARR_API_KEY` - any 32-character hex string (`openssl rand -hex 16`). The compose file passes it to Prowlarr as `PROWLARR__AUTH__APIKEY`, which overrides the key Prowlarr would otherwise generate, so Findr and Prowlarr agree from the first start.

### 2. Start

```bash
docker compose up -d                          # Prowlarr
docker compose --profile flaresolverr up -d   # ...and FlareSolverr
docker compose ps
```

### 3. Prowlarr

Open http://localhost:9696. On first visit Prowlarr asks you to choose an authentication method for its web UI; pick **Forms** and set a login. This doesn't affect Findr, which uses the API key.

Then add indexers under **Indexers → Add Indexer**. Findr searches every enabled indexer. [Internet Archive](https://archive.org) is a good first one to confirm everything works, since it's public and its content is legal to download. Note that it reports every torrent as 1 seeder (archive.org serves them over HTTP), so Findr's default minimum of 5 seeders rejects them all; lower **Settings → Release preferences → Minimum seeders** while testing with it.

If you started FlareSolverr and an indexer needs it:

1. **Settings → Indexers → Add → FlareSolverr**, host `http://flaresolverr:8191/`, and give it a tag such as `flaresolverr`.
2. Add the same tag to each indexer that sits behind Cloudflare. Untagged indexers don't use it.

### 4. Point Findr at it

Start Findr and sign in. On **Settings → Services**, set:

- **Prowlarr URL** - `http://localhost:9696`
- **Prowlarr API key** - the same value as `PROWLARR_API_KEY` in `docker/.env`. (If you're pointing Findr at a Prowlarr instance you didn't set up with this stack, find the key instead in Prowlarr's own UI under **Settings → General → Security → API Key**.)

Then set the library paths on **Settings → Library paths**.

## Everyday use

```bash
docker compose logs -f prowlarr               # follow a service's logs
docker compose pull && docker compose up -d   # update images
docker compose down                           # stop (state in config/ is kept)
```

To pin versions, set `PROWLARR_TAG` and `FLARESOLVERR_TAG` in `.env` to specific tags.

## Running Findr in Docker

Every release also publishes a container image for `linux/amd64` and `linux/arm64`: `ghcr.io/benzo-fury/findr`, tagged with the version (`1.4.0`), the minor line (`1.4`) and `latest`. It holds the release's executable plus mkvmerge, ffmpeg and `ip`, so there is nothing else to install. Add it to your `compose.yml`:

```yaml
  findr:
    image: ghcr.io/benzo-fury/findr:latest    # or pin a version, e.g. :1.4
    container_name: findr
    user: "1000:1000"                         # the host user that owns the library folders
    environment:
      - TZ=Etc/UTC
    volumes:
      - ./config/findr:/data                  # database, session secret, optional .env
      - /srv/media:/srv/media                 # library and scratch folders, at the same paths
    ports:
      - 127.0.0.1:34571:34571                 # web app
      - 6881:6881                             # torrent port (TCP and UDP)
      - 6881:6881/udp
    restart: unless-stopped
```

- **Paths** - mount the library and downloads folders at the paths you enter under **Settings → Library paths**; mounting them at the same path inside and out keeps that simple. Point **Prowlarr URL** at `http://prowlarr:9696` when both are in this stack.
- **First sign-in** - the initial `admin` / `admin` login, and replacing it, are only accepted from the machine Findr runs on. Through a published port a request comes from Docker's network, not loopback, so do this one step from inside the container, choosing your own email and password:

  ```bash
  docker exec findr sh -c '
    H="-H Origin:http://localhost:34571 -H Content-Type:application/json"
    curl -sf -c /tmp/jar $H http://localhost:34571/api/auth/sign-in/email -d "{\"email\":\"admin\",\"password\":\"admin\"}" > /dev/null &&
    curl -sf -b /tmp/jar $H http://localhost:34571/api/account/credentials -d "{\"email\":\"you@example.com\",\"password\":\"a long password\"}" &&
    curl -sf -b /tmp/jar $H -X PATCH http://localhost:34571/api/settings -d "{\"access\":{\"allowRemote\":true}}" > /dev/null &&
    echo "Credentials set, remote access on"; rm -f /tmp/jar'
  ```

  This also turns on **Settings → Access → Allow remote access**, without which Findr refuses every request from outside the container. Then sign in from the browser with your new credentials; behind a reverse proxy, set **Public URL** too.
- **Updates** - Findr knows it runs in a container (the image sets `FINDR_CONTAINER=true`), so it only announces new releases. Update with `docker compose pull findr && docker compose up -d findr`, ideally while no downloads are running. Everything that matters lives in `/data`, so it carries over.
- **On a VPN** - give it `network_mode: "service:gluetun"` instead of `ports:`, as in [docs/VPN.md](../docs/VPN.md#linux-a-network-namespace-or-docker-with-a-vpn-container), and set the killswitch's interface to the VPN container's (`tun0` or `wg0`).

## Notes

- **Prowlarr's web UI is bound to 127.0.0.1** so only this machine can reach it. If Findr runs on another host, set `BIND_ADDRESS=0.0.0.0` and put it behind a firewall or VPN.
- **Prowlarr's download links** point at the address Findr used to search (the Prowlarr URL in its settings). Findr fetches `.torrent` files itself, so nothing else needs to reach Prowlarr.
- **Torrent traffic** comes from Findr, not from this stack. Its port is set under **Settings → Torrent client** in Findr (default 6881); forward it on your router for better speeds. To keep it on a VPN, use Findr's VPN killswitch; to put Prowlarr and FlareSolverr on the VPN too, see [docs/VPN.md](../docs/VPN.md#prowlarr-and-flaresolverr).
