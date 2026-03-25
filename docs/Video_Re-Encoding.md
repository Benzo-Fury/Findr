# Video Re-Encoding

When Findr downloads a video, it re-encodes it to strip out any potentially harmful data and produce a clean file. This re-encoding step is handled by [ffmpeg](https://ffmpeg.org/), a widely used open-source video processing tool.

Most modern computers have a dedicated chip specifically designed to encode video. It's way faster and more efficient than making your CPU do the work. Findr automatically detects whether your system has one of these chips and uses it. If it doesn't find one, it falls back to software encoding (your CPU does the work instead, slower, but works on every machine).

## Auto Probing

On first transcode, Findr probes your ffmpeg binary and picks the highest-ranked encoder that is available:

1. **VideoToolbox** (`h264_videotoolbox`) - macOS, Apple Silicon & Intel
2. **NVENC** (`h264_nvenc`) - NVIDIA GPUs
3. **Quick Sync** (`h264_qsv`) - Intel integrated graphics
4. **VA-API** (`h264_vaapi`) - Linux, Intel & AMD
5. **AMF** (`h264_amf`) - AMD GPUs on Windows
6. **libx264** - Software fallback, works everywhere

## Custom ffmpeg & exotic hardware

Some hardware (like Rockchip boards) needs a special version of ffmpeg compiled with support for its encoding chip . The standard ffmpeg you'd install from a package manager won't include it. For these cases, Findr lets you point at your own ffmpeg binary and pass in whatever encoder flags you need.

For example, I (the dev) run Findr on an RK3588 board that has a built-in encoding chip. I have a custom ffmpeg installed that knows how to talk to it, and I just tell Findr to use that binary and pass in the right flags:

```json
{
  "paths": {
    "ffmpeg": "/usr/local/bin/ffmpeg-rkmpp" // or just "ffmpeg" if it's in your path
  },
  "ffmpeg": {
    "disableAutoEncoder": true,
    "extraArgs": ["-c:v", "h264_rkmpp", "-rc_mode", "CQP", "-qp_init", "26"]
  }
}
```

> [!NOTE]
> For additioanl information regarding the config system, see [Config.md](/docs/Config.md).
