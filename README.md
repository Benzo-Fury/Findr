<div align="center">
  <img src="apps/web/public/findr-banner-rounded.png" width="900px"/>
  <h1>Find. Anything.</h1>
  <h4>Download any movie or TV show, ready for Plex or Jellyfin.</h4>
</div>

## What is Findr?

Findr is a self-hosted app for downloading movies and TV shows.

You search for a title, click **Download**, and Findr does the rest:

1. Searches your torrent indexers (through [Prowlarr](https://prowlarr.com/)).
2. Picks the best release for your quality preferences.
3. Downloads it with its own built-in torrent client.
4. Cleans the file down to just video and audio.
5. Names it and moves it into your library, ready for Plex or Jellyfin.

If a torrent is fake, dead, too slow or contains something dodgy, Findr throws it away and tries the next one by itself.

<table>
  <tr>
    <td><img src="apps/web/public/ui-example-1.png" width="450px"/></td>
    <td><img src="apps/web/public/ui-example-2.png" width="450px"/></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="apps/web/public/ui-example-3.png" width="450px"/></td>
  </tr>
</table>

## Features

- **One click** - search or browse movies and shows, then download a film or a whole season.
- **Picks the best release** - ranks every result by resolution, codec, HDR, source, size and seeders, and skips cams, wrong years and wrong seasons.
- **Built-in torrent client** - no qBittorrent or Transmission needed. Findr doesn't seed.
- **Safe files** - checks each torrent's file list before downloading and rejects executables, scripts and archives. Only the video files are downloaded.
- **Clean output** - every file is remuxed to video and audio only, and only common containers and codecs get into your library.
- **Full seasons** - grabs a season pack when there is one, otherwise downloads each episode separately.
- **Never stuck** - stalled or slow torrents are dropped and the next one is tried.
- **Watch in the browser** *(optional)* - play your library without a media server, with resume, continue watching, next episode and scrubbing thumbnails, and cast it to a TV with Chromecast, AirPlay or DLNA, on the server's network or yours (a small bridge reaches DLNA TVs away from the server). Files are sent as they are when the device can play them, and converted when it can't, on the CPU or a hardware encoder. See [docs/Playback.md](docs/Playback.md).
- **VPN killswitch** *(optional)* - torrent traffic only goes through your VPN, and downloads pause if it drops. See [docs/VPN.md](docs/VPN.md).
- **Wrong-title filter** *(optional)* - uses Claude to weed out releases for a different movie or show.
- **Single binary** - one executable for Linux, macOS and Windows, or a Docker image.

## What you need

- **[Prowlarr](https://prowlarr.com/)** - to search your torrent indexers. There's a ready-made Docker setup in [`docker/`](docker/README.md) that runs it alongside Findr.
- **[ffmpeg](https://ffmpeg.org/)** (`ffmpeg`, `ffprobe`) - to clean the files and play them. Already included in the binaries and the Docker image; only running from source needs it installed.
- **A [TMDB API key](https://developer.themoviedb.org/)** - free; used for titles, posters and episode lists.
- **An [Anthropic API key](https://console.anthropic.com/)** *(optional)* - only for the wrong-title filter.

## Install

### Binary

Download the `findr-<system>` file for your system from the [latest release](https://github.com/Benzo-Fury/Findr/releases) and run it. It's a single file with nothing else to install.

> [!NOTE] Platform Notes
> **Linux and macOS:** downloaded files aren't executable yet. Run `chmod +x findr-*` first.
>
> **macOS:** also run `xattr -d com.apple.quarantine findr-*`, or macOS refuses to open it (Findr isn't notarized by Apple).
>
> **Windows:** if SmartScreen warns about the file, choose **More info → Run anyway**.

### Docker

One Compose file runs Findr with Prowlarr, with nothing to edit:

```bash
mkdir -p findr/config/findr findr/config/prowlarr findr/media && cd findr
curl -fsSL https://github.com/Benzo-Fury/Findr/releases/latest/download/compose.yml -o compose.yml
docker compose up -d
docker compose logs findr    # shows the setup code
```

Then open http://localhost:34571 and enter the setup code. More in [docker/README.md](docker/README.md).

### From source

Needs [Bun](https://bun.sh) 1.4+ and [ffmpeg](https://ffmpeg.org/) (with `ffprobe`) on your `PATH`.

```bash
git clone https://github.com/Benzo-Fury/Findr.git
cd Findr
bun install
bun run build
bun run start
```

> [!NOTE]
> Findr stores its data in a `data/` folder next to wherever you run it.

## Setup

Open **http://localhost:34571** and setup walks you through it: your own login, your TMDB and Prowlarr keys, where downloads, movies and TV shows go, and a check that ffmpeg is there.

- **On the machine Findr runs on**, sign in with `admin` / `admin` to start.
- **From another machine** (a headless server, a container), enter the setup code Findr prints in its log when it starts. That also turns on **Settings → Access → Allow access from other machines**.

Then search for something and hit **Download**.

Everything else (naming, quality preferences, VPN, the torrent port, auto-updates) is in Settings. Every option is explained in [docs/Config.md](docs/Config.md).

**Locked out?** Stop Findr, delete `data/findr.db`, and start it again. You'll be back to `admin` / `admin` and a new setup code (and a fresh library list).

## Updates

Findr tells you when a new version is out. The binary can update itself in one click (or automatically, in Settings). Docker users pull the new image; source users pull and rebuild.

## Development

```bash
bun install
bun run dev                  # open http://localhost:34571
cd apps/api && bun test      # tests (some need ffmpeg and ffprobe)
bun run build --target linux-x64   # cross-compile for another platform
```

## Legal

Findr is a tool. It doesn't host, index or distribute any content - it only downloads what you ask it to from the indexers you set up.

**Don't use Findr to break the law.** Downloading copyrighted material you don't have the rights to is illegal in many countries. You are responsible for what you download, and the developers accept no liability for how Findr is used.

## Credits

Inspired by [Roundup](https://github.com/0xlunar/roundup) by [0xlunar](https://github.com/0xlunar).

## License

Findr is licensed under the [Apache License 2.0](LICENSE). The executables also carry an unmodified FFmpeg build, which is GPL-licensed; see [docs/ThirdParty.md](docs/ThirdParty.md).

How Findr handles downloaded files, and the risks that remain, are in [docs/Security.md](docs/Security.md).
