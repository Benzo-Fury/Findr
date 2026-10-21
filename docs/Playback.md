# Playback

Findr can play what it has downloaded in the browser, so a separate media server isn't needed. Only finished library files play: nothing streams from a torrent, and nothing plays until the pipeline has sterilised and saved the file.

Playback is on by default and can be switched off under **Settings → Playback** (`playback.enabled`). Turning it off takes effect at once: every running session ends, its ffmpeg process is stopped, its scratch files are deleted, every TV Findr is driving is stopped, every playback route answers `playback_disabled`, and the web app hides Play, Resume and Continue watching. Indexed files and watch history are kept, and come back when it is switched on again; no restart is needed either way.

It needs `ffmpeg` and `ffprobe` on the server (`FFMPEG_PATH`, `FFPROBE_PATH`). The Docker image includes them. Without them nothing plays, and downloading is unaffected.

## Indexing

When a download saves a file, Findr reads it once with ffprobe in the background: its duration, bitrate, video stream (codec, profile and level, size, frame rate, bit depth, HDR), every audio track, and the time of every video keyframe. The result is stored with the file. Files are read one at a time, so a large library doesn't compete with downloads.

When playback starts, or is switched back on, Findr reconciles the index against the library. Files saved while it was off are read, changed files are read again, files read by an older version of Findr that recorded less are read again (keeping their keyframes), and files that have disappeared are forgotten. Episode numbers come from the pipeline; for files saved before playback existed they are read from the file name, so the episode naming template must keep `{episode}`.

## How a file reaches a device

The player sends what the device can decode (video and audio codecs, screen height, HDR). Findr then picks the cheapest way to send the file:

| Mode | When | Cost |
|---|---|---|
| Original stream | The device decodes the video and audio as they are. | Copying only. |
| Converting audio | The video plays, but the audio doesn't (DTS and TrueHD, for example). Audio becomes stereo AAC. | Small. Always allowed. |
| Converting video | The video codec, 10-bit H.264, a resolution above the screen, HDR on a non-HDR screen, or the bitrate limit rules out copying. Video becomes H.264. | High. Needs `playback.transcoding`, and counts toward `maxConcurrentTranscodes`. |

The player's settings panel says which mode is in use and why.

Every mode is served as fragmented-MP4 HLS. Library files are Matroska, which Safari and iOS don't play, so copying into HLS is what lets every browser play them. Only the chosen video and audio streams are mapped; metadata, chapters and anything else in the file stay behind. Copied HEVC is tagged `hvc1`, which Apple's players require.

Following Apple's HLS guidance, a session's `index.m3u8` is a multivariant playlist with one variant. It gives the bitrate, codecs (named as RFC 6381 does, from the file's profile and level, or from the encoder's settings), resolution, frame rate and dynamic range, so a player knows what it is getting before it fetches any media. The peak bitrate is the average plus 10%, the allowance ffmpeg's own HLS muxer makes. A codec Findr can't name exactly is left out of the playlist rather than guessed.

## Segments and seeking

The playlist lists the whole runtime before any segment exists, so the player can seek anywhere at once.

Copied video can only be cut on its own keyframes, so its segments start on the first keyframe at least `segmentSeconds` after the previous cut. Converted video places a keyframe every `segmentSeconds`, so its segments are exact.

One ffmpeg process per session produces segments. Its timestamps stay on the file's own timeline, so segments from different runs line up. A request for a segment just ahead waits for it. A request further away (a seek) restarts ffmpeg at that segment.

When `throttleTranscodes` is on, Findr stops reading ffmpeg's output once it is `throttleAheadSeconds` ahead of the player, which pauses ffmpeg. Segments more than `segmentKeepSeconds` behind the player are deleted, and a session the player stops asking about for a minute is ended.

Media is served under `/api/playback/stream/<token>/`, where the token is signed with a key derived from the auth secret. It grants access to that one session only, and expires.

## Converting video

Transcodes use x264 on the CPU unless `hardwareAcceleration` names a hardware encoder: VideoToolbox on a Mac, NVENC on NVIDIA, Quick Sync on Intel, VA-API on Linux with Intel or AMD graphics, AMF on AMD under Windows, or Rockchip's MPP. Only encoding moves to the hardware; decoding, scaling and tone mapping stay on the CPU, so every encoder behaves the same way and needs nothing but ffmpeg built with it. **Test encoder** on the Settings page converts a few seconds of a test picture with the saved choice and shows ffmpeg's complaint if it fails. In a container, the device (`/dev/dri` for VA-API and Quick Sync, the NVIDIA runtime for NVENC) has to be passed through; the Docker image includes the VA-API drivers for Intel (on amd64) and AMD graphics, and [docker/README.md](../docker/README.md) shows the setup.

HDR video sent to a screen without HDR is tone mapped to SDR when `toneMapping` is on, using ffmpeg's `zscale` and `tonemap` filters. The Docker image's ffmpeg has them. Without `zscale`, Findr logs a warning at startup and converts HDR without tone mapping, which looks washed out.

## Scrubbing thumbnails

With `trickplay` on, Findr makes small thumbnails of every library file after indexing it, one every `trickplayIntervalSeconds`, `trickplayWidth` pixels wide, in sheets of 100. Only keyframes are decoded, so a two-hour film takes well under a minute. They live in a `trickplay` folder beside the database, and are made again when either setting changes or the file does. The player shows them above the timeline while you drag it.

## Casting

With `casting` on, the player offers three ways to send what is playing to a TV. Your phone, tablet or laptop then becomes the remote; the TV fetches the video from Findr itself, so the device you cast from can sleep without the video stopping.

| | Receivers | Works from | How |
|---|---|---|---|
| Google Cast | Chromecast, Google TV, Android TV, most Sony, Hisense, TCL and Philips TVs | Chrome or Edge on a computer or Android | The Cast button in the control bar. The TV gets its own session, sized for it: H.264 (High, up to level 4.1, the oldest Chromecasts' limit) and AAC up to 1080p, converted when the file needs it. |
| AirPlay | Apple TV, and AirPlay 2 TVs from Samsung, LG, Sony and Vizio | Safari on a Mac, iPhone or iPad | The AirPlay button in the control bar. Safari plays the stream itself rather than through hls.js, so it can hand the same stream over. |
| DLNA | Most other smart TVs, games consoles, Kodi | Any browser | The Cast button on the Library page, or the TV button at the top of the player, lists the TVs Findr finds on its network. Findr drives the TV from the server; the page becomes its remote. |

**Picking a TV before playing.** A DLNA TV picked from the Library's Cast button (floating in the bottom corner) stays picked for the browser tab: every Play, Resume or Continue watching card then starts on that TV straight away, from the saved position, and the next episode follows on it. The button stays lit with the TV's name while one is picked; choose **This device**, or **Watch here** on the remote, to play in the browser again. Picking a TV in the player picks it the same way. While picked and idle, the TV shows a Findr splash (a still photo, for TVs that list JPEG among their formats) until something plays; unpicking it clears the splash, but never stops something already playing.

**Getting back to a TV.** While a TV plays something you started, the Cast button shows on every page, with what is playing and where. Its menu shows how far in it is, plays, pauses and stops it, and **Open remote** goes back to its remote. Opening the remote of something the TV is already playing, from there or from its Play or Resume button, picks it up where it is rather than starting it again; **Start over** and the next episode send it again.

**The DLNA remote.** On a keyboard, Space or K plays and pauses, the left and right arrows (or J and L) skip back 10 and forward 30 seconds, the up and down arrows change the TV's volume, M mutes, and Escape goes back, leaving the TV playing. A file resumed part-way is seeked on the TV once it has really started (some TVs report playing while still opening the file and ignore a seek sent then); the remote shows it as starting meanwhile, and no progress is saved until it reaches the resume point. A TV that won't start or seek the file within 30 seconds is sent a stream from the resume point instead; while it is paused, the 30 seconds wait.

The browser finds Cast and AirPlay devices itself, so it must be on the same network as the TV. For DLNA, Findr searches from the server, so the *server* must be on the TV's network; the browser can be anywhere it can reach Findr. DLNA's search is a multicast that doesn't cross Docker's bridge network, so a container needs `network_mode: host` to find TVs (see [docker/README.md](../docker/README.md)). Anything on the network can answer a search, so Findr takes an answer only when the device description it names is on the device that answered, follows no redirects, and drives only services on that same device.

**Which address a TV uses.** A TV is handed an absolute URL, so Findr has to know an address the TV can reach: `castBaseUrl` if set, otherwise this machine's private IPv4 address and Findr's port. Set `castBaseUrl` when that is wrong, as when Findr runs in a container on a bridge network. TVs on the local network may fetch media at these URLs even while remote access is off: Findr lets through requests from private addresses for media paths carrying a valid token, and the splash image shown on a picked TV, and nothing else.

**Google Cast and HTTPS.** Google's default receiver runs on HTTPS. Most Cast devices play media from a plain `http://` address on the local network, but if a device shows an error as soon as you cast, set `castBaseUrl` to an HTTPS address for Findr, such as one through a reverse proxy.

**DLNA in detail.** Findr asks each TV which formats it accepts, and labels what it sends with the TV's own name for the format, so the stream's `protocolInfo` matches one the TV listed. A TV that lists Matroska gets the library file as it is, with byte ranges, when it can decode the streams in it; any other gets an MPEG-TS that ffmpeg produces as the TV reads it, copying what the TV decodes and converting the rest. Some TVs list Matroska, fetch the file and then never play it, Sony's among them: if a file hasn't started within 15 seconds, or the TV reports an error, Findr sends the same thing again as MPEG-TS from where it was meant to start, and sends that TV MPEG-TS until Findr restarts. TVs list containers rather than codecs, so Findr assumes H.264 and AAC or MP3, and adds HEVC, AC-3, E-AC-3 and 4K only when the TV's list names them; many 4K TVs don't, and their HEVC files are then converted. Seeking a file goes to the TV; seeking a converted stream loads it again from the new position. Findr reads the TV's position every two seconds and saves progress as the browser does, counting a stream as started only once that position moves forward (as it opens a new item, a TV can still report the last one's position), lets the TV go a minute after it stops, and leaves out renderers that take only audio, such as speakers. Anyone signed in can cast; only the person who started something on a TV can pause, seek or stop it. Some TVs, Sony's among them, only answer the command to play once they have started the stream, so Findr waits up to 20 seconds and, if the TV still hasn't answered, keeps watching its state rather than giving up. The log says when a TV first fetches its stream; if a TV fails and that line never appears, the TV couldn't reach Findr's address (check `castBaseUrl` and the server's firewall).

## Now playing

Admins see every session at the top of **Settings → Playback**: who is watching what, on which device, how far in, and how it is being sent (the original file or streams, audio converted, or video converted on the CPU or hardware), with a button that stops it. Stopping a DLNA session stops the TV too.

## Watching

- **Resume** - stopping between `minResumePercent` and `maxResumePercent` of the runtime keeps the position, and the next Play offers *Resume* or *Start over*. Past `maxResumePercent` the item counts as watched, and its position is cleared. Watching it again keeps a position the same way, so a rewatch stopped part-way resumes too, while it stays marked watched. Items shorter than `minResumeDurationSeconds` always start from the beginning.
- **Watched** - movies and episodes can be marked watched or unwatched by hand from the title sheet.
- **Continue watching** - the Library shows anything part-way through, most recent first, then the next unwatched episode of each show in progress.
- **Next episode** - when an episode ends, the next one on disk is offered and starts after a countdown, unless the viewer turns this off in the player. After a few episodes in a row the player asks whether anyone is still watching.
- **Audio** - the viewer can pick any audio track. The language they pick is remembered for that show, and as their preferred language for everything else.
- **Quality** - the viewer can cap the bitrate from the player, and the cap is remembered on that device. Off the local network, `remoteMaxBitrateMbps` caps it too.

Subtitles are not available yet: the pipeline removes them from library files.
