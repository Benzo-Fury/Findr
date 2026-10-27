# Findr in Docker

This folder is the whole stack as one Docker Compose file: **Findr** itself, **Prowlarr** to search your indexers, and **FlareSolverr** as an optional helper for indexers behind Cloudflare. Findr downloads torrents with its own built-in client, so nothing else is needed.

| Service | Image | Port | Purpose |
|---|---|---|---|
| Findr | [`ghcr.io/benzo-fury/findr`](https://github.com/Benzo-Fury/Findr/pkgs/container/findr) | 34571 (localhost only), 6881 torrents | The downloader and web app |
| Prowlarr | [`lscr.io/linuxserver/prowlarr`](https://docs.linuxserver.io/images/docker-prowlarr/) | 9696 (localhost only) | Indexer manager; Findr calls its search API |
| FlareSolverr *(optional)* | [`ghcr.io/flaresolverr/flaresolverr`](https://github.com/FlareSolverr/FlareSolverr) | internal only | Cloudflare challenge solver used by Prowlarr |

## Quick start

```bash
mkdir -p findr/config/findr findr/config/prowlarr findr/media && cd findr
curl -fsSL https://github.com/Benzo-Fury/Findr/releases/latest/download/compose.yml -o compose.yml
docker compose up -d
docker compose logs findr
```

Making the folders first matters: Docker would otherwise create them owned by root, and the containers, which run as your user, couldn't write to them.

The log shows a **setup code**. Open http://localhost:34571, enter the code, and choose your email and password. Setup then walks you through the rest:

- **Your TMDB API key** - free from [themoviedb.org](https://www.themoviedb.org/settings/api).
- **Prowlarr** - already filled in. Findr reaches it at `http://prowlarr:9696` and reads its API key from Prowlarr's own settings, so there's nothing to copy across.
- **Library folders** - already filled in: `/media/movies`, `/media/tv` and `/media/downloads`, which are `media/` in your `findr` folder.
- **ffmpeg** - included in the image.

Claiming the server with the code also turns on **Settings → Access → Allow remote access**, so you can use Findr from the browser you claimed it from.

### Prowlarr

Open http://localhost:9696. On first visit Prowlarr asks you to choose an authentication method for its web UI; pick **Forms** and set a login. This doesn't affect Findr, which uses the API key.

Then add indexers under **Indexers → Add Indexer**. Findr searches every enabled indexer. [Internet Archive](https://archive.org) is a good first one to confirm everything works, since it's public and its content is legal to download. It reports every torrent as 1 seeder (archive.org serves them over HTTP), so Findr's default minimum of 5 seeders rejects them all; lower **Settings → Release preferences → Minimum seeders** while testing with it.

If an indexer needs FlareSolverr, start it with `docker compose --profile flaresolverr up -d`, then:

1. **Settings → Indexers → Add → FlareSolverr** in Prowlarr, host `http://flaresolverr:8191/`, with a tag such as `flaresolverr`.
2. Add the same tag to each indexer that sits behind Cloudflare. Untagged indexers don't use it.

## Changing the container defaults

Everything about Findr itself is changed under **Settings**. A few things are decided by Docker before Findr starts, so Settings can't change them. To change one, put it in a `.env` file beside `compose.yml` and run `docker compose up -d` again. [`.env.example`](.env.example) lists them all, including image tags; the ones you're most likely to need:

- `BIND_ADDRESS` - `127.0.0.1` (the default) keeps the web UIs private to this machine, even with **Allow remote access** on. Use `0.0.0.0` to reach them from other devices, behind a firewall or VPN.
- `PUID` / `PGID` - the user and group that own the files the containers write (`id -u`, `id -g`); default 1000.
- `MEDIA_ROOT` - the host folder mounted at `/media` in Findr; default `./media`. Library paths in Settings are inside this folder.
- `TORRENT_PORT` - the torrent port Docker opens (default 6881). If you change it, set the same value under **Settings → Torrent client**.

## Everyday use

```bash
docker compose logs -f findr                  # follow Findr's log
docker compose pull && docker compose up -d   # update
docker compose down                           # stop (everything in config/ and media/ is kept)
```

Findr knows it runs in a container (the image sets `FINDR_CONTAINER=true`), so it only announces new releases rather than updating itself. Update while no downloads are running if you can.

## Running Findr on the host instead

Using the `findr` binary or `bun run start`? Start only Prowlarr with `docker compose up -d prowlarr`, and in Findr's setup use `http://localhost:9696` and the key from Prowlarr's **Settings → General → Security → API Key**.

## Notes

- **The image** is published for `linux/amd64` and `linux/arm64` with every release, tagged with the version (`1.4.0`), the minor line (`1.4`) and `latest`. It holds the release's executable, with its ffmpeg, plus `ip` and the VA-API and Quick Sync drivers.
- **Behind a reverse proxy**, set **Settings → Access → Public URL**.
- **Casting to TVs** - Findr finds DLNA TVs with a multicast search that doesn't cross Docker's bridge network, so to cast to one give the `findr` service `network_mode: host` instead of `ports:` (TVs then reach it on the host's own address). On a bridge network, Chromecast and AirPlay still work from the browser, but set **Settings → Playback → Address for TVs** (`castBaseUrl`) to an address TVs can reach, such as `http://192.168.1.10:34571`. To cast to DLNA TVs on a different network from the server's, run a [cast bridge](../docs/Playback.md#tvs-on-another-network) on that network: `docker run -d --restart unless-stopped --network host -e FINDR_BRIDGE_TOKEN=<token> ghcr.io/benzo-fury/findr findr bridge --server <Findr's address>`. See [docs/Playback.md](../docs/Playback.md#casting).
- **Hardware encoding** - the image's ffmpeg has every hardware encoder, and the image includes the VA-API drivers for Intel and AMD graphics and Intel's Quick Sync runtime (amd64 only). Pass the devices through and add the container's user to the host's `render` group (`group_add: ["<render group id>"]`):
  - **Intel or AMD:** `devices: ["/dev/dri:/dev/dri"]`.
  - **NVIDIA:** the NVIDIA container runtime (`runtime: nvidia`, or a `deploy.resources.reservations.devices` entry for the GPU) with `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`.
  - **Rockchip** (a board on Rockchip's own kernel): every one of `/dev/mpp_service`, `/dev/rga`, `/dev/dri` and `/dev/dma_heap` that exists, plus the host's `video` group.

  **Test encoder** under **Settings → Playback** confirms it works.
- **On a VPN** - give Findr `network_mode: "service:gluetun"` instead of `ports:`, as in [docs/VPN.md](../docs/VPN.md#linux-a-network-namespace-or-docker-with-a-vpn-container), and set the killswitch's interface to the VPN container's (`tun0` or `wg0`).
- **Prowlarr's download links** point at the address Findr used to search. Findr fetches `.torrent` files itself, so nothing else needs to reach Prowlarr.
- **Torrent traffic** comes from Findr, not Prowlarr. Forward `TORRENT_PORT` on your router for better speeds. To keep it on a VPN, use Findr's VPN killswitch; to put Prowlarr and FlareSolverr on the VPN too, see [docs/VPN.md](../docs/VPN.md#prowlarr-and-flaresolverr).
