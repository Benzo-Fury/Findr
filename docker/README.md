# External services

Findr downloads torrents with its own built-in client, so the only service it needs beside it is **Prowlarr**, to search your indexers. This folder is the whole stack as one Docker Compose file: **Findr** itself, **Prowlarr**, and **FlareSolverr** as an optional helper for indexers behind Cloudflare. Copy `compose.example.yml` and `.env.example`, edit `.env`, and `docker compose up -d`.

Running Findr on the host instead (the `findr` binary or `bun run start`)? Start only Prowlarr with `docker compose up -d prowlarr`.

| Service | Image | Port | Purpose |
|---|---|---|---|
| Findr | [`ghcr.io/benzo-fury/findr`](https://github.com/Benzo-Fury/Findr/pkgs/container/findr) | 34571 (localhost only), 6881 torrents | The downloader and web app |
| Prowlarr | [`lscr.io/linuxserver/prowlarr`](https://docs.linuxserver.io/images/docker-prowlarr/) | 9696 (localhost only) | Indexer manager; Findr calls its search API |
| FlareSolverr *(optional)* | [`ghcr.io/flaresolverr/flaresolverr`](https://github.com/FlareSolverr/FlareSolverr) | internal only | Cloudflare challenge solver used by Prowlarr |

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
- `MEDIA_ROOT` - the host folder holding your library and downloads, e.g. `/srv/media`. It is mounted at the same path inside Findr's container, so the paths you enter under **Settings → Library paths** are the real ones.
- `TORRENT_PORT` - Findr's torrent port (default 6881). If you change it, set the same value under **Settings → Torrent client**.
- `PROWLARR_API_KEY` - any 32-character hex string (`openssl rand -hex 16`). The compose file passes it to Prowlarr as `PROWLARR__AUTH__APIKEY`, which overrides the key Prowlarr would otherwise generate, so Findr and Prowlarr agree from the first start.

### 2. Start

```bash
docker compose up -d                          # Findr and Prowlarr
docker compose --profile flaresolverr up -d   # ...and FlareSolverr
docker compose ps
```

### 3. Prowlarr

Open http://localhost:9696. On first visit Prowlarr asks you to choose an authentication method for its web UI; pick **Forms** and set a login. This doesn't affect Findr, which uses the API key.

Then add indexers under **Indexers → Add Indexer**. Findr searches every enabled indexer. [Internet Archive](https://archive.org) is a good first one to confirm everything works, since it's public and its content is legal to download. Note that it reports every torrent as 1 seeder (archive.org serves them over HTTP), so Findr's default minimum of 5 seeders rejects them all; lower **Settings → Release preferences → Minimum seeders** while testing with it.

If you started FlareSolverr and an indexer needs it:

1. **Settings → Indexers → Add → FlareSolverr**, host `http://flaresolverr:8191/`, and give it a tag such as `flaresolverr`.
2. Add the same tag to each indexer that sits behind Cloudflare. Untagged indexers don't use it.

### 4. First sign-in and Findr's settings

First replace the initial `admin` / `admin` login with the command under [Running Findr in Docker](#running-findr-in-docker) below (it only works from inside the container). Then open http://localhost:34571, sign in, and on **Settings → Services** set:

- **Prowlarr URL** - `http://prowlarr:9696` (`http://localhost:9696` if Findr runs on the host)
- **Prowlarr API key** - the same value as `PROWLARR_API_KEY` in `docker/.env`. (If you're pointing Findr at a Prowlarr instance you didn't set up with this stack, find the key instead in Prowlarr's own UI under **Settings → General → Security → API Key**.)

Then set the library paths on **Settings → Library paths**.

## Everyday use

```bash
docker compose logs -f findr                  # follow a service's logs
docker compose pull && docker compose up -d   # update images
docker compose down                           # stop (state in config/ is kept)
```

To pin versions, set `PROWLARR_TAG` and `FLARESOLVERR_TAG` in `.env` to specific tags.

## Running Findr in Docker

Every release publishes a container image for `linux/amd64` and `linux/arm64`: `ghcr.io/benzo-fury/findr`, tagged with the version (`1.4.0`), the minor line (`1.4`) and `latest`. It holds the release's executable plus mkvmerge, ffmpeg and `ip`, so there is nothing else to install. The `findr` service in `compose.example.yml` runs it; pin a version with `FINDR_TAG` in `.env`. The notes below cover what differs in a container.

- **Paths** - mount the library and downloads folders at the paths you enter under **Settings → Library paths**; mounting them at the same path inside and out keeps that simple. Point **Prowlarr URL** at `http://prowlarr:9696`, since both are in this stack.
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
- **Updates** - Findr knows it runs in a container (the image sets `FINDR_CONTAINER=true`), so it only announces new releases. Update with `docker compose pull && docker compose up -d`, ideally while no downloads are running. Everything that matters lives in `/data`, so it carries over.
- **Casting to TVs** - Findr finds DLNA TVs with a multicast search that doesn't cross Docker's bridge network, so to cast to one give the `findr` service `network_mode: host` instead of `ports:` (TVs then reach it on the host's own address). On a bridge network, Chromecast and AirPlay still work from the browser, but set **Settings → Playback → Address for TVs** (`castBaseUrl`) to an address TVs can reach, such as `http://192.168.1.10:34571`. To cast to DLNA TVs on a different network from the server's, run a [cast bridge](../docs/Playback.md#tvs-on-another-network) on that network: `docker run -d --restart unless-stopped --network host -e FINDR_BRIDGE_TOKEN=<token> ghcr.io/benzo-fury/findr findr bridge --server <Findr's address>`. See [docs/Playback.md](../docs/Playback.md#casting).
- **Hardware encoding** - the image includes the VA-API drivers for Intel (amd64 only) and AMD graphics. Pass the device through with `devices: ["/dev/dri:/dev/dri"]` and add the container's user to the host's `render` group (`group_add: ["<render group id>"]`); for NVENC, use the NVIDIA container runtime instead. **Test encoder** under **Settings → Playback** confirms it works.
- **On a VPN** - give it `network_mode: "service:gluetun"` instead of `ports:`, as in [docs/VPN.md](../docs/VPN.md#linux-a-network-namespace-or-docker-with-a-vpn-container), and set the killswitch's interface to the VPN container's (`tun0` or `wg0`).

## Notes

- **The web UIs are bound to 127.0.0.1** so only this machine can reach them. To reach Findr or Prowlarr from other devices, set `BIND_ADDRESS=0.0.0.0` and put it behind a firewall or VPN (Findr also needs **Allow remote access**, which the first sign-in command turns on).
- **Prowlarr's download links** point at the address Findr used to search (the Prowlarr URL in its settings). Findr fetches `.torrent` files itself, so nothing else needs to reach Prowlarr.
- **Torrent traffic** comes from Findr, not Prowlarr. Its port is `TORRENT_PORT` (default 6881); forward it on your router for better speeds. To keep it on a VPN, use Findr's VPN killswitch; to put Prowlarr and FlareSolverr on the VPN too, see [docs/VPN.md](../docs/VPN.md#prowlarr-and-flaresolverr).
