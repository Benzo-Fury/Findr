# Third-party software

Findr itself is licensed under the Apache License 2.0. The standalone executables also carry a copy of **FFmpeg** (`ffmpeg` and `ffprobe`), which Findr runs as separate programs to clean downloads and play your library. FFmpeg is a separate work under its own licence, described below.

## FFmpeg

- **Version:** 9.0.2
- **Licence:** GNU General Public License, version 3 or later. These builds include GPL components such as libx264, so the whole build is under the GPL rather than the LGPL. The full text is at <https://www.gnu.org/licenses/gpl-3.0.html>.
- **Copyright:** the FFmpeg developers. See <https://ffmpeg.org/legal.html>.

FFmpeg is not part of Findr's source and is not modified. The executables contain it unchanged, compressed, and write it out beside Findr's database the first time it is used.

### Where each build comes from

| Executable | Build | Built by |
|---|---|---|
| `findr-linux-x64`, `findr-linux-arm64`, `findr-darwin-x64`, `findr-darwin-arm64` | Static release builds | [Martin Riedl's FFmpeg build server](https://ffmpeg.martin-riedl.de/) |
| `findr-windows-x64` | "essentials" release build | [Gyan Doshi (codexffmpeg)](https://github.com/GyanD/codexffmpeg) |

The exact download addresses and their SHA-256 hashes are pinned in [`apps/api/scripts/tools.json`](../apps/api/scripts/tools.json). The build refuses any file that doesn't match.

### Source code

As the GPL requires, the corresponding source is available:

- **FFmpeg 9.0.2:** <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz>
- **Build scripts and configuration:** published by each builder above, alongside their builds.

If any of these links stops working, open an issue on Findr's repository and the source will be provided.

The Docker image doesn't use this copy. It runs Debian's `ffmpeg` package, whose source is available from Debian.
