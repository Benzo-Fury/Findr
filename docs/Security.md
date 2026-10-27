# Security

Findr downloads files from strangers. Any release can be fake, broken or built to attack something. This page describes what Findr assumes about those files, how it handles them, and the risks that remain.

## Threat model

**What an attacker controls:** everything in a torrent. That includes:

- its file names and folder layout;
- every byte of every file;
- the release title that indexers report;
- the data that peers send over the network.

They can publish a release that looks like the film you asked for.

**What they want:** one of three things:

- run code on the machine Findr runs on;
- read or change Findr's data (accounts, session tokens, API keys) or files outside the library;
- get something harmful into the library, where a media server or player opens it later.

**Out of scope here:**

- Someone who can already write to Findr's data folder or run commands on the server.
- The security of Prowlarr, your indexers or your media server.

## How a download is handled

Each step narrows what reaches the next.

1. **Before downloading.** Findr reads the torrent's file list, but no file contents. Any executable or script anywhere in the torrent rejects it, and so does a torrent that only has archives. Only video files in containers Findr takes are selected: `.mkv`, `.webm`, `.mp4`, `.m4v` and `.mov`. Nothing else is downloaded, and the other files are never created on disk.
2. **File paths.** The torrent engine refuses any path part that is empty, `.` or `..`, or that contains a separator or a NUL byte. It has no support for symlinks, so every file is a regular file inside the attempt's own folder. Findr checks again that each resolved path is inside that folder before anything opens it.
3. **Container check.** The file's first bytes must be a Matroska/WebM header or an MP4/MOV `ftyp` box. Its name doesn't count. Anything else is rejected without ffmpeg ever opening it: AVI, MPEG-TS, a playlist, a disguised executable, or random data.
4. **How ffmpeg opens files.** ffmpeg and ffprobe get the input in a fixed way:
   - **Forced format** (`-f matroska` or `-f mov`), so they never guess a format and never load another demuxer.
   - **Local files only** (`-protocol_whitelist file`), so a file can't make them open a URL, a pipe or a concatenation of other files.
   - **Literal path**, passed as a `file:` URL, so a name like `concat:a|b.mkv` or `-i.mkv` is just a name.
   - **No external references**, so MP4 references to media in other files are never followed (`-enable_drefs 0`).
5. **Codec allowlist.** Only common, heavily tested codecs are kept:
   - video: H.264, HEVC, AV1 and VP9;
   - audio: AAC, AC-3, E-AC-3, DTS, TrueHD, FLAC, Opus, MP3, Vorbis and PCM.

   Cover art is dropped. A file with no allowed video, or with audio but none of it allowed, is rejected.
6. **Remux.** What survives is copied, not re-encoded, into a new Matroska file holding only video and audio. Subtitles, attachments (fonts, images), chapters, tags and titles are not carried over; audio keeps its language.
7. **Saving.** The file goes into the library under a name Findr builds from the title (TMDB data, with illegal characters removed). It is written under a hidden temporary name and renamed into place.
8. **Playback.** Library files are opened the same strict way, as Matroska only. A file that isn't Matroska is never indexed.

Any step that hangs is stopped by the attempt's watchdog, after `watchdog.stuckTimeoutMinutes` (10 by default).

**Torrent engine.** Findr's torrent engine, TinyTorrent, is written in TypeScript, so a malformed message from a peer can't corrupt memory the way it could in a C client. It also doesn't seed.

**ffmpeg itself.** Compiled executables carry a pinned FFmpeg build, checked against its hash when the build is made and again on every start (see [ThirdParty.md](ThirdParty.md)). The path to ffmpeg can only be set in the environment, never from the browser. A setting would let a hijacked admin session make the server run any program.

**First sign-in.** A fresh install accepts `admin` / `admin` only from the server itself. Claiming it from another machine needs the setup code printed in the server's log:

- 12 characters from a 31-character alphabet, about 59 bits;
- at most 10 tries a minute from each address;
- made afresh on every start;
- gone once the credentials are set.

Until then, other machines can reach only the web app's files, the claim and the session check.

## Remaining risks

Ordered by how much they matter.

### 1. A malicious video stream in an allowed codec

- **Severity:** high.
- **Likelihood:** low.

The remux checks the container but copies the compressed video and audio data unchanged. A stream built to exploit a bug in a decoder (H.264, HEVC, AV1, VP9 or an audio codec) passes through into the library untouched. Decoders run on it in three places:

- **Trickplay:** scrubbing thumbnails are made automatically for every new library file. Making them decodes the video's keyframes, without anyone pressing Play.
- **Conversion during playback:** when a device can't play the file as it is.
- **Players and media servers:** Plex, Jellyfin, VLC or a TV that opens the file.

FFmpeg's decoders are among the most fuzzed code anywhere, but memory-safety bugs in them are still found and fixed regularly. Findr can't detect such a stream.

**Mitigations:**

- **Now:** turn off `playback.trickplay` (or playback entirely) if you never watch in the browser. Then no decoder touches a download until someone plays it.
- **Later:** run ffmpeg in a sandbox (see 2), or re-encode downloads instead of remuxing. Re-encoding replaces the stream with one ffmpeg wrote itself, but costs hours of CPU per film and some quality.

### 2. ffmpeg runs with all of Findr's access

- **Severity:** high, if 1 or 3 happens.
- **Likelihood:** low.

ffmpeg and ffprobe run as the same user as Findr, with the same files and the same network. Code running inside an exploited ffmpeg could:

- read `findr.db`, which holds session tokens and the TMDB, Prowlarr and Anthropic keys;
- read `auth.secret`;
- change the library;
- make connections that don't go through the VPN killswitch, which only governs the torrent engine's sockets.

**Mitigations:**

- **Now:** run Findr in Docker, as an unprivileged user (the image does), with only the folders it needs mounted. If you can, also use `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` and `read_only: true` with the data and media folders as writable mounts.
- **Later:**
  - **Linux:** run each ffmpeg in its own namespace with no network and a read-only view of everything but its input and output (`bwrap`, `systemd-run`, or landlock and seccomp).
  - **macOS:** use a `sandbox-exec` profile.

  ffmpeg needs no network for anything Findr asks of it.

### 3. Bugs in the Matroska and MP4 demuxers

- **Severity:** high.
- **Likelihood:** low.

Every downloaded file is parsed by ffprobe and ffmpeg's Matroska or MOV demuxer before Findr decides whether to keep it. The container check and forced format keep the other several hundred demuxers out of reach. These two are still parsing hostile data, so a bug in either is reachable by any download.

**Mitigations:**

- **Now:** keep ffmpeg current (see 4).
- **Later:** a sandbox (see 2), or a minimal ffmpeg built with only these two demuxers and the allowed codecs. That removes the remaining unused code from the binary entirely.

### 4. Patch delay for ffmpeg

- **Severity:** medium.
- **Likelihood:** medium.

The copy built into the executables changes only when Findr releases. The Docker image carries the same copy. Until then, a published ffmpeg vulnerability stays open on every install.

**Mitigations:**

- **Now:** set `FFMPEG_PATH` and `FFPROBE_PATH` to a system ffmpeg that your package manager keeps patched.
- **Later:** release Findr promptly when an FFmpeg fix lands, bumping [`apps/api/scripts/tools.json`](../apps/api/scripts/tools.json) and rebuilding the image.

### 5. Trust in third-party FFmpeg builds

- **Severity:** high.
- **Likelihood:** very low.

The bundled builds are the Jellyfin project's portable FFmpeg builds. Pinned hashes guarantee that every Findr build uses the same file that was reviewed when it was pinned. They can't show that the file was clean at that point.

**Mitigation:** later, build FFmpeg in Findr's own release workflow from the official source tarball. Done as a minimal build, this also addresses 3.

### 6. Resource use from crafted files

- **Severity:** low.
- **Likelihood:** low.

A file can be built to be slow to parse or to hold hundreds of tracks. A test file with 200 audio tracks was cleaned in under a second. Every allowed track is kept, so such a file stays in the library with all of them.

Parsing that never finishes is stopped by the watchdog. Output is about the size of the input, so a remux can't fill the disk much faster than downloading did.

**Mitigation:** later, cap the number of audio tracks kept.

### 7. An unclaimed server open to the network

- **Severity:** low.
- **Likelihood:** low.

If `BIND_ADDRESS` is `0.0.0.0` and the install hasn't been claimed yet, anyone on the network sees the claim screen. Without the code they can't claim it, and guessing is infeasible at 10 tries a minute.

**Mitigation:** claim the server right after starting it, as setup asks.

## What was checked, and what wasn't

**Checked:**

- **Automated tests:** the test suite covers each of these:
  - the container check (Matroska, MP4, AVI, a playlist named `.mkv`, random bytes);
  - the forced input options;
  - the codec allowlist;
  - dropping cover art and attachments;
  - truncated files;
  - the bundled binary's hash check and replacement of a swapped copy;
  - the setup code (wrong code, reuse, remote access only after a remote claim);
  - what an unclaimed server lets through.
- **Crafted samples run through the real sterilizer:**
  - names that look like ffmpeg protocols or options (`concat:base.mkv|x.mkv`, `-i.mkv`) were opened as plain files;
  - a file with 200 audio tracks was cleaned;
  - MPEG-TS renamed `.mp4` was rejected by its bytes;
  - a Matroska header followed by random data was rejected.
- **By reading the code:** torrent path handling.

**Not checked:**

- No fuzzing of ffmpeg, and no attempt at a real decoder exploit.
- The Docker stack was not run end to end.
- The Linux and Windows executables were built but not run.
- The robustness of the torrent engine's protocol parsing was not reviewed.
- Downstream players and media servers opening library files were not tested.
