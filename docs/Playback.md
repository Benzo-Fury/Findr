# Playback

Findr can play what it has downloaded in the browser, so a separate media server isn't needed. Only finished library files play: nothing streams from a torrent, and nothing plays until the pipeline has sterilised and saved the file.

Playback is on by default and can be switched off under **Settings → Playback** (`playback.enabled`). Turning it off takes effect at once: every running session ends, its ffmpeg process is stopped, its scratch files are deleted, every TV Findr is driving is stopped, every playback route answers `playback_disabled`, and the web app hides Play, Resume and Continue watching. Indexed files and watch history are kept, and come back when it is switched on again; no restart is needed either way.

It uses the same `ffmpeg` and `ffprobe` as the download pipeline: the copy built into the executables, the Docker image's own, or one you install (see [finding ffmpeg](Config.md#server)). Every library file is opened strictly as Matroska from the local disk, never left to ffmpeg to guess, and a file that isn't Matroska is never indexed.

## Indexing

When a download saves a file, Findr reads it once with ffprobe in the background: its duration, bitrate, video stream (codec, profile and level, size, frame rate, bit depth, HDR), every audio track, and the time of every video keyframe. The result is stored with the file. Files are read one at a time, so a large library doesn't compete with downloads.

When playback starts, or is switched back on, Findr reconciles the index against the library. Files saved while it was off are read, changed files are read again, files read by an older version of Findr that recorded less are read again (keeping their keyframes), and files that have disappeared are forgotten. Episode numbers come from the pipeline; for files saved before playback existed they are read from the file name, so the episode naming template must keep `{episode}`.

## How a file reaches a device

The player sends what the device can decode: its video and audio codecs, its screen's height and whether the screen shows HDR. A browser also measures each video codec's decoder through Media Capabilities: the tallest picture it decodes smoothly, whether it takes 10-bit, and whether it decodes HDR10 and maps it down to an SDR screen itself. Findr judges a file by what the decoder takes rather than what the screen shows, so a 4K or HDR file that a 1080p or SDR screen's browser still decodes is sent as it is, and the browser scales or maps it down at no cost to the server. Firefox isn't trusted to map HDR down, since it shows HDR washed out. Nothing is copied deeper than 10-bit. Chromecasts can't measure themselves, so they are judged by the `chromecastProfile` setting; DLNA TVs by the formats they list, corrected by an admin (see [DLNA in detail](#casting)).

Findr then picks the cheapest way to send the file:

| Mode | When | Cost |
|---|---|---|
| Original stream | The device decodes the video and audio as they are. | Copying only. |
| Converting audio | The video plays, but the audio doesn't (DTS and TrueHD, for example). Audio becomes stereo AAC. | Small. Always allowed. |
| Converting video | The video codec, 10-bit video the decoder doesn't take (10-bit H.264 always), a picture taller than the decoder takes, HDR the device can't show, the bitrate limit, or a copy that already failed to decode on this device rules out copying. Video becomes H.264, sized to the screen. | High. Needs `playback.transcoding`, and counts toward `maxConcurrentTranscodes`. |

The player's settings panel says which mode is in use and why.

Measurements can be optimistic. When a browser fails to decode a copied stream, the player starts a new session from the same moment with the video converted, and remembers in that browser what failed (HDR, then 10-bit, then the picture size, then the codec), so the next file of the kind is converted from the start.

For an HDR file on an SDR screen, the player's settings menu has **Convert HDR on the server**, saved per user. It has the server tone map HDR to SDR instead of the browser, for browsers whose own mapping looks dim or flat. It costs a transcode.

Every mode is served as fragmented-MP4 HLS. Library files are Matroska, which Safari and iOS don't play, so copying into HLS is what lets every browser play them. Only the chosen video and audio streams are mapped; metadata, chapters and anything else in the file stay behind. Copied HEVC is tagged `hvc1`, which Apple's players require.

Following Apple's HLS guidance, a session's `index.m3u8` is a multivariant playlist with one variant. It gives the bitrate, codecs (named as RFC 6381 does, from the file's profile and level, or from the encoder's settings), resolution, frame rate and dynamic range, so a player knows what it is getting before it fetches any media. The peak bitrate is the average plus 10%, the allowance ffmpeg's own HLS muxer makes. A codec Findr can't name exactly is left out of the playlist rather than guessed.

## Segments and seeking

The playlist lists the whole runtime before any segment exists, so the player can seek anywhere at once.

Copied video can only be cut on its own keyframes, so its segments start on the first keyframe at least `segmentSeconds` after the previous cut. Converted video places a keyframe every `segmentSeconds`, so its segments are exact.

One ffmpeg process per session produces segments. Its timestamps stay on the file's own timeline, so segments from different runs line up. A request for a segment just ahead waits for it. A request further away (a seek) restarts ffmpeg at that segment.

When `throttleTranscodes` is on, Findr stops reading ffmpeg's output once it is `throttleAheadSeconds` ahead of the player, which pauses ffmpeg. Segments more than `segmentKeepSeconds` behind the player are deleted, and a session the player stops asking about for a minute is ended.

Media is served under `/api/playback/stream/<token>/`, where the token is signed with a key derived from the auth secret. It grants access to that one session only, and expires.

## Converting video

Converting a 4K HDR film means decoding it, scaling it down, mapping HDR to SDR and encoding H.264. Findr runs as much of that as it can on the graphics hardware: VideoToolbox on a Mac, NVENC on NVIDIA, Quick Sync on Intel, VA-API on Linux with Intel or AMD graphics, AMF on AMD under Windows, or Rockchip's MPP. `hardwareAcceleration` is `auto` by default, which uses the first of these that works on the machine; naming one uses only that one, and `none` keeps everything on the CPU.

When playback starts, and whenever the playback settings change, Findr checks the hardware with ffmpeg in about a second: whether its encoder works, which video it decodes (H.264, HEVC, AV1 and VP9, 8- and 10-bit, each checked by bringing decoded frames back from the device), and whether it scales and tone maps there. **Test hardware** on the Settings page runs the check again and shows what it found, with ffmpeg's complaint for anything that didn't work.

Each conversion then starts on the highest of four rungs the check allows for that file:

| Rung | Decoding | Scaling | Tone mapping | Encoding |
|---|---|---|---|---|
| All on hardware | Hardware | Hardware | Hardware | Hardware |
| Decoded on hardware | Hardware | Hardware where it can | CPU | Hardware |
| Encoded on hardware | CPU | CPU | CPU | Hardware |
| CPU | CPU | CPU | CPU | x264 |

A conversion that fails before producing anything is started again one rung down from the same place, and that kind of conversion (the same video codec and bit depth, scaling and tone mapping) starts on the lower rung from then on, until the settings change or the hardware is tested again. Once a stream's first segment has gone to the player, it only steps down to rungs with the same encoder, so the player can carry on with the stream it has. A machine whose hardware doesn't work at all converts on the CPU rather than failing to play.

The ffmpeg inside the executables and the Docker image has every one of these built in. What it can't carry is the driver that runs the chip, which belongs to the machine:

- **VideoToolbox** - nothing to install; it's part of macOS.
- **NVENC** - the NVIDIA driver. In Docker, the NVIDIA container runtime with the `video` capability.
- **VA-API** (Intel or AMD on Linux) - libva and the VA-API driver for the graphics (`intel-media-va-driver` or `mesa-va-drivers` on Debian and Ubuntu). The Docker image includes them.
- **Quick Sync** (Intel) - Intel's media driver and Quick Sync runtime (`intel-media-va-driver` and `libmfx-gen1.2`). The Docker image includes them on amd64.
- **AMF** (AMD on Windows) - the AMD graphics driver.
- **Rockchip MPP** - a board running Rockchip's own (BSP) kernel, 5.10 or 6.1, as most RK35xx board images do; mainline kernels lack the MPP driver. It's ready when `/dev/mpp_service`, `/dev/rga`, `/dev/dri` and `/dev/dma_heap` exist and Findr's user can open them. MPP decodes, the RGA scales and MPP encodes; the RK3588 is the one to use for 4K, and older chips encode H.264 at 1080p. HDR is tone mapped on the RK3588's Mali GPU through OpenCL, which also needs `/dev/mali0` and Rockchip's Mali driver (libmali; the arm64 Docker image includes it), so the board converts HDR on the "all on hardware" rung; without them it does so on the "decoded on hardware" rung, tone mapping on the CPU. In Docker, the container also has to be allowed to read the device tree, or MPP can't tell which chip it runs on and won't decode: see [docker/README.md](../docker/README.md).

Quick Sync on Linux decodes through VA-API on the same GPU and hands the frames to Quick Sync for scaling, tone mapping and encoding, so both use `vaapiDevice`. VA-API tone mapping works on Intel graphics only; AMD converts HDR on the "decoded on hardware" rung.

The Mali GPU loads its firmware the first time anything uses it. Long after boot, memory can be too fragmented for that to work (the kernel log says `Failed to allocate 512 physical pages`), and HDR is then tone mapped on the CPU until the machine restarts. Findr checks the hardware as it starts, so started at boot it loads the firmware early.

**Checks.** Under Settings → Playback, admins see how well this machine plays: everything that stops a conversion running as fully on the hardware as it could, worst first, each with what to do about it (often a few lines to add to `compose.yml`, ready to copy). They cover hardware turned off or failing, device files missing from a container or closed to Findr's user, Rockchip's hidden device tree, missing Rockchip and NVIDIA devices, formats the hardware doesn't decode (with how many library files they affect), scaling and tone mapping left on the CPU (and why: no GPU device, no OpenCL driver, or the Mali firmware failing to load), an ffmpeg without a fast or any CPU tone mapper, few cores, little memory, little room where conversions are written, NVIDIA's limit on encodes, conversions that fell back to a slower rung since the hardware was last tested, and library files whose audio is converted on every play. Anything that stops playback working as it should also shows as a banner on admins' Library page.

In a container the devices have to be passed through; [docker/README.md](../docker/README.md) shows the setup.

HDR video sent to a screen that can't show it is tone mapped to SDR (BT.2390) when `toneMapping` is on: on the hardware where it can, otherwise on the CPU with `tonemapx`, the SIMD tone mapper in the ffmpeg built into the executables and the Docker image, which is several times faster than zscale. An ffmpeg without `tonemapx` falls back to `zscale` and `tonemap`; one with neither converts HDR without tone mapping, which looks washed out, and Findr logs a warning at startup.

## Scrubbing thumbnails

With `trickplay` on, Findr makes small thumbnails of every library file after indexing it, one every `trickplayIntervalSeconds`, `trickplayWidth` pixels wide, in sheets of 100. Only keyframes are decoded, so a two-hour film takes well under a minute. They live in a `trickplay` folder beside the database, and are made again when either setting changes or the file does. The player shows them above the timeline while you drag it.

## Casting

With `casting` on, the player offers three ways to send what is playing to a TV. Your phone, tablet or laptop then becomes the remote; the TV fetches the video from Findr itself, so the device you cast from can sleep without the video stopping.

| | Receivers | Works from | How |
|---|---|---|---|
| Google Cast | Chromecast, Google TV, Android TV, most Sony, Hisense, TCL and Philips TVs | Chrome or Edge on a computer or Android | The Cast button in the control bar. The TV gets its own session, sized for it by `chromecastProfile`: by default H.264 (High, up to level 4.1, the oldest Chromecasts' limit) and AAC up to 1080p; with the 4K models chosen, HEVC Main 10, 4K and HDR10 as well. Anything else is converted. |
| AirPlay | Apple TV, and AirPlay 2 TVs from Samsung, LG, Sony and Vizio | Safari on a Mac, iPhone or iPad | The AirPlay button in the control bar. Safari plays the stream itself rather than through hls.js, so it can hand the same stream over. |
| DLNA | Most other smart TVs, games consoles, Kodi | Any browser | The Cast button on the Library page, or the TV button at the top of the player, lists the TVs Findr finds on its own network and through its [bridges](#tvs-on-another-network). Findr drives the TV from the server; the page becomes its remote. |

**Picking a TV before playing.** A DLNA TV picked from the Library's Cast button (floating in the bottom corner) stays picked for the browser tab: every Play, Resume or Continue watching card then starts on that TV straight away, from the saved position, and the next episode follows on it. The button stays lit with the TV's name while one is picked; choose **This device**, or **Watch here** on the remote, to play in the browser again. Picking a TV in the player picks it the same way. While picked and idle, the TV shows a Findr splash (a still photo, for TVs that list JPEG among their formats) until something plays; unpicking it clears the splash, but never stops something already playing.

**Getting back to a TV.** While a TV plays something you started, the Cast button shows on every page, with what is playing and where. Its menu shows how far in it is, plays, pauses and stops it, and **Open remote** goes back to its remote. Opening the remote of something the TV is already playing, from there or from its Play or Resume button, picks it up where it is rather than starting it again; **Start over** and the next episode send it again.

**The DLNA remote.** On a keyboard, Space or K plays and pauses, the left and right arrows (or J and L) skip back 10 and forward 30 seconds, the up and down arrows change the TV's volume, M mutes, and Escape goes back, leaving the TV playing. A file resumed part-way is seeked on the TV once it has really started (some TVs report playing while still opening the file and ignore a seek sent then); the remote shows it as starting meanwhile, and no progress is saved until it reaches the resume point. A TV that won't start or seek the file within 30 seconds is sent a stream from the resume point instead; while it is paused, the 30 seconds wait.

**Which TVs you can cast to.** The browser finds Cast and AirPlay devices itself, so those are the TVs on the network your phone or laptop is on, wherever Findr runs. DLNA TVs are found by Findr, so they are the TVs on the server's own network, plus those on any network with a [cast bridge](#tvs-on-another-network) connected. DLNA's search is a multicast that doesn't cross Docker's bridge network, so a container needs `network_mode: host` to find TVs (see [docker/README.md](../docker/README.md)). Anything on the network can answer a search, so Findr takes an answer only when the device description it names is on the device that answered, follows no redirects, and drives only services on that same device.

**Which address a TV uses.** A TV is handed an absolute URL, so Findr has to know an address the TV can reach. A TV on the server's network gets `castBaseUrl` if set, otherwise this machine's private IPv4 address and Findr's port; set `castBaseUrl` when that is wrong, as when Findr runs in a container on a bridge network. A Chromecast or AirPlay TV cast to from a browser outside the server's network gets the **Public URL** under Access instead (or `castBaseUrl`, if that is a public address), and fetches over the internet; without one, the player doesn't offer Cast there. That needs remote access on, and the TV's stream is held to the bitrate limit for devices outside your network. A DLNA TV reached through a bridge fetches from the bridge. TVs on the local network may fetch media at these URLs even while remote access is off: Findr lets through requests from private addresses for media paths carrying a valid token, and the splash image shown on a picked TV, and nothing else.

**Google Cast and HTTPS.** Google's default receiver runs on HTTPS. Most Cast devices play media from a plain `http://` address on the local network, but if a device shows an error as soon as you cast, set `castBaseUrl` to an HTTPS address for Findr, such as one through a reverse proxy. A Public URL is usually HTTPS already.

**DLNA in detail.** Findr asks each TV which formats it accepts, and labels what it sends with the TV's own name for the format, so the stream's `protocolInfo` matches one the TV listed. A TV that lists Matroska gets the library file as it is, with byte ranges, when it can decode the streams in it and the chosen audio track is the file's default (a TV playing the file picks its track itself); any other gets an MPEG-TS that ffmpeg produces as the TV reads it, copying what the TV decodes and converting the rest. Some TVs list Matroska, fetch the file and then never play it, Sony's among them: if a file hasn't started within 15 seconds, or the TV reports an error, Findr sends the same thing again as MPEG-TS from where it was meant to start, and sends that TV MPEG-TS until Findr restarts. TVs list containers rather than codecs, so Findr assumes H.264 and AAC or MP3, and adds HEVC (10-bit included), AC-3, E-AC-3 and 4K only when the TV's list names them; many 4K TVs don't, and no TV says whether it shows HDR. An admin can correct that on the TV's remote under **What this TV plays**, setting HEVC, 4K and HDR each to Automatic (what the TV lists), Yes or No; the choice is kept for that TV and applies from the next video sent to it. A TV that is sent copied video in MPEG-TS and doesn't start it within 15 seconds, or reports an error, is sent the same thing again converted, from where it was meant to start, and is taken not to play that kind of video (HDR, then 10-bit, then 4K, then HEVC) until Findr restarts. Seeking a file goes to the TV; seeking a converted stream loads it again from the new position. Findr reads the TV's position every two seconds and saves progress as the browser does, counting a stream as started only once that position moves forward (as it opens a new item, a TV can still report the last one's position), lets the TV go a minute after it stops, and leaves out renderers that take only audio, such as speakers. Anyone signed in can cast; only the person who started something on a TV can pause, seek or stop it. Some TVs, Sony's among them, only answer the command to play once they have started the stream, so Findr waits up to 20 seconds and, if the TV still hasn't answered, keeps watching its state rather than giving up. The log says when a TV first fetches its stream; if a TV fails and that line never appears, the TV couldn't reach Findr's address (check `castBaseUrl`, or the bridge's `--media-url`, and the firewall in between).

### TVs on another network

When Findr runs somewhere else, such as on a server in a data centre, it can't search the network your TVs are on. A **cast bridge** does that for it: the same `findr` executable, run as `findr bridge` on any always-on machine on that network (a Raspberry Pi, a NAS, a desktop). It connects out to Findr, so nothing has to be opened on your router, and from then on the TVs it finds are listed with the server's own, each marked with the bridge's name.

To add one, an admin opens **Settings → Playback**, enters where the bridge is (such as *Home*) under **TV bridges**, and runs the command shown:

```bash
findr bridge --server https://findr.example.com --token fcb_…
```

The token is shown only then; Findr keeps a hash of it. Removing the bridge on the same page disconnects it at once, and it stops, saying so. The list shows whether each bridge is connected, how many TVs it last found, and the version it runs; the bridge and the server must run the same version of Findr.

| Option | Environment | Default | |
|---|---|---|---|
| `--server` | `FINDR_SERVER` | - | Findr's address, as you open it in the browser. |
| `--token` | `FINDR_BRIDGE_TOKEN` | - | The bridge's token. The environment keeps it out of the process list. |
| `--port` | `FINDR_BRIDGE_PORT` | `34572` | The port TVs fetch video from. |
| `--media-url` | `FINDR_BRIDGE_MEDIA_URL` | this machine's address | The address TVs fetch from, when the bridge's own address on the network isn't it (in a container on a bridge network). |

The server must accept connections from other machines (**Settings → Access → Allow remote access**), as it already does if you open it from elsewhere. The bridge keeps one WebSocket open to `/api/playback/bridges/connect` and reconnects whenever it drops, so it survives the server restarting. A wrong token, or remote access being off, stops the bridge with a message saying what to change.

TVs fetch video from the bridge, over plain HTTP on the local network as TVs handle best, and the bridge fetches it from Findr, passing byte ranges and DLNA's headers both ways. Video therefore crosses the internet once, at the rate the TV plays it, and is held to the bitrate limit for devices outside your network. In Docker, run the bridge with `--network host`, so its search reaches the TVs: `docker run -d --restart unless-stopped --network host -e FINDR_BRIDGE_TOKEN=fcb_… ghcr.io/benzo-fury/findr findr bridge --server https://findr.example.com`.

The server can ask a bridge for only two things: a search, and HTTP requests to devices that answered the bridge's own search, carrying only the headers a TV's controls need. Nothing else on the bridge's network is reachable through it. Its media proxy answers only machines on its local network, and only for streams under a valid token and the splash.

## Now playing

Admins see every session at the top of **Settings → Playback**: who is watching what, on which device, how far in, and how it is being sent (the original file or streams, audio converted, or video converted, and on which rung: all on hardware, decoded and encoded on hardware, encoded on hardware, or on the CPU), with a button that stops it. Stopping a DLNA session stops the TV too.

## Watching

- **Resume** - stopping between `minResumePercent` and `maxResumePercent` of the runtime keeps the position, and the next Play offers *Resume* or *Start over*. Past `maxResumePercent` the item counts as watched, and its position is cleared. Watching it again keeps a position the same way, so a rewatch stopped part-way resumes too, while it stays marked watched. Items shorter than `minResumeDurationSeconds` always start from the beginning.
- **Watched** - movies and episodes can be marked watched or unwatched by hand from the title sheet.
- **Continue watching** - the Library shows anything part-way through, most recent first, then the next unwatched episode of each show in progress.
- **Next episode** - once an episode's end credits start, a single **Next Episode** button offers the next episode on disk; its amber fill counts down 10 seconds and then starts it, skipping the rest of the credits. Pausing holds the countdown; seeking within the credits or pressing Escape stops it for this episode, leaving the button. Where the credits can't be found, it is offered only at the end. The countdown runs only while autoplay is on (the player's settings menu), and after a few episodes in a row it stops counting down, so Findr doesn't play on to an empty room. On a DLNA TV the server moves on by itself, so episodes keep chaining with no remote open; an open remote shows the same button and countdown and follows the TV to the next episode, and seeking or Escape there stops this one moving on. Pressing anything on the remote resets the "still watching" count.
- **Credits** - where an episode's credits start is looked up the first time it plays, and kept with the file (looked up again if the file changes). [TheIntroDB](https://theintrodb.org) is asked first, by the show's TMDB id, season, episode and the file's length; it needs no key, and only those numbers are sent. For episodes it doesn't cover, Findr reads the file's last five minutes itself: it matches the ending's audio against the episodes either side (a Chromaprint fingerprint, so a theme song every episode ends on is found; needs an ffmpeg with Chromaprint, which the bundled Linux build has), then looks for credits on a black background lasting to the end. Credits found that way, or not found, are looked up on TheIntroDB again after a week; if TheIntroDB couldn't be reached, after an hour. A season premiere that ends on a different song than the rest of its season is usually not found, and falls back to the end.
- **Audio** - a file's audio tracks are all kept in the library file, and the viewer can pick any of them from the player's settings, listed by language with their codec and channels. The pipeline doesn't keep track names, so two tracks in one language are numbered. The switch happens where the viewer is: in the browser and on AirPlay the new stream replaces the old one in the same player, paused if it was paused; on Google Cast the receiver is loaded with the new track while the browser stays idle; on a DLNA TV the remote's audio button sends the video again from the TV's position. The language picked is remembered for that show, and as the preferred language for everything else.
- **Quality** - the viewer can cap the bitrate from the player, and the cap is remembered on that device. Off the local network, `remoteMaxBitrateMbps` caps it too. It switches the same way as audio.
- **Keyboard** - in the player, Space or K plays and pauses, the left and right arrows (or J and L) skip 10 seconds, the up and down arrows change the volume, M mutes, F toggles fullscreen, I picture-in-picture, 0 to 9 jump to that tenth of the runtime, Home and End to the start and end, and < and > change the speed. They work anywhere on the page, not only once the player has focus.

Subtitles are not available yet: the pipeline removes them from library files.
