# Third-party software

Findr itself is licensed under the Apache License 2.0. The standalone executables and the Docker image also carry a copy of **FFmpeg** (`ffmpeg` and `ffprobe`), which Findr runs as separate programs to clean downloads and play your library. FFmpeg is a separate work under its own licence, described below.

## FFmpeg

- **Version:** jellyfin-ffmpeg 8.1.3-1, Jellyfin's build of FFmpeg 8.1.3 with its hardware acceleration patches.
- **Licence:** GNU General Public License, version 3 or later. These builds include GPL components such as libx264, so the whole build is under the GPL rather than the LGPL. The full text is at <https://www.gnu.org/licenses/gpl-3.0.html>.
- **Copyright:** the FFmpeg developers and the Jellyfin contributors. See <https://ffmpeg.org/legal.html>.

Findr doesn't modify these builds. The executables contain them unchanged, compressed, and write them out beside Findr's database the first time they're used.

### Where each build comes from

Every executable carries the "portable" build for its platform, published by the [Jellyfin project](https://github.com/jellyfin/jellyfin-ffmpeg/releases/tag/v8.1.3-1):

| Executable | Build |
|---|---|
| `findr-linux-x64` | `portable_linux64-gpl` |
| `findr-linux-arm64` | `portable_linuxarm64-gpl` |
| `findr-darwin-x64` | `portable_mac64-gpl` |
| `findr-darwin-arm64` | `portable_macarm64-gpl` |
| `findr-windows-x64` | `portable_win64-clang-gpl` |

The exact download addresses and their SHA-256 hashes are pinned in [`apps/api/scripts/tools.json`](../apps/api/scripts/tools.json). The build refuses any file that doesn't match. The Docker image uses the copy inside its Linux executable.

### Source code

As the GPL requires, the corresponding source is available:

- **jellyfin-ffmpeg 8.1.3-1** (FFmpeg 8.1.3, Jellyfin's patches and the scripts that make the portable builds): <https://github.com/jellyfin/jellyfin-ffmpeg/tree/v8.1.3-1>
- **FFmpeg 8.1.3:** <https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz>

If any of these links stops working, open an issue on Findr's repository and the source will be provided.
