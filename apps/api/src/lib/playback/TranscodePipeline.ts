/**
 * Builds the ffmpeg arguments that re-encode video to H.264, for every
 * hardware API and for each rung of the ladder a transcode falls down when a
 * stage won't run on the hardware:
 *
 * - `device`: decoded, scaled, tone mapped and encoded on the hardware, the
 *   frames never leaving it.
 * - `decode`: decoded on the hardware (and scaled there when it can), brought
 *   back to the CPU for tone mapping, and encoded on the hardware.
 * - `encode`: decoded and filtered on the CPU, encoded on the hardware.
 * - `cpu`: everything on the CPU, with x264.
 *
 * Every rung gives the same picture size, an 8-bit 4:2:0 frame, a keyframe
 * every `keyframeSeconds` counted from the start of the run and no B-frames,
 * so presentation and decode times agree and segments cut cleanly whichever
 * rung made them.
 *
 * The filter names are those of the pinned jellyfin-ffmpeg build
 * (`scripts/tools.json`). Whether a chain really runs on a machine is found
 * out by `HardwareProbe`, and at play time by stepping down a rung, never
 * assumed from this table.
 *
 * Pure: everything it needs is passed in, so it is tested as a table.
 */

import { type HardwareApi, type PlaybackSettings, type TranscodeRung, TranscodeRungSchema } from "@findr/types/playback";

// ---------- Types ---------- //

/** How much of a transcode runs on the hardware. */
export type Rung = TranscodeRung;

/** The rungs in order, from all on the hardware to none of it. */
export const RUNGS: readonly Rung[] = TranscodeRungSchema.options;

/** How an encode should come out, whatever encoder makes it. */
export interface VideoEncode {
  /** Height to scale to, or null to keep the source's. */
  scaleToHeight: number | null;
  /** Video bitrate ceiling, or null for quality-based encoding. */
  bitrateCap: number | null;
  /** The bitrate expected at this height, for encoders that only take a target. */
  bitrateEstimate: number;
  /** Convert HDR to SDR on the way. */
  toneMap: boolean;
  /** Seconds between forced keyframes. */
  keyframeSeconds: number;
}

/** The video being re-encoded, as far as building the chain needs it. */
export interface TranscodeSource {
  width: number;
  height: number;
  bitDepth: number;
}

/** The video half of an ffmpeg command: what goes before the input, and after it. */
export interface VideoArgs {
  input: string[];
  output: string[];
  rung: Rung;
  encoder: string;
}

/** ffmpeg's filter names, as `Ffmpeg.filters` reads them. */
export type FilterSet = ReadonlySet<string>;

/**
 * One hardware API: how it decodes with frames left on the device, the
 * filters it has there, how frames cross between it and the CPU, and its
 * encoder.
 */
interface Device {
  encoder: string;
  /** Arguments before the input that decode on the device. */
  decode(settings: PlaybackSettings): string[];
  /**
   * Arguments before the input for the `device` rung when it tone maps, where
   * the tone mapper needs a device of its own opened beside the decoder's
   * (Rockchip's OpenCL on the Mali GPU); `decode` otherwise.
   */
  toneMapDecode?(settings: PlaybackSettings): string[];
  /** Whether decoded frames stay on the device (and so need `download` to reach the CPU). */
  framesOnDevice: boolean;
  /** A filter that hands decoded frames to the device's own filters and encoder, when they decode elsewhere. */
  enter?: string;
  /** Arguments before the input when only encoding on the device. */
  encodeOnly(settings: PlaybackSettings): string[];
  /** A device filter that scales to `width`×`height` (null keeps the size) into `format`; null when it has none. */
  scale(width: number | null, height: number | null, format: "nv12" | "p010"): string | null;
  /** A device filter that maps HDR to 8-bit SDR BT.709; null when it has none. */
  toneMap: string | null;
  /** Filters that hand CPU frames to the encoder. */
  upload: string[];
  /**
   * Whether its decoder lays 10-bit frames out in a way `hwdownload` can't
   * read (Rockchip's packed NV15), so they pass through its scaler as P010
   * on the way to the CPU.
   */
  packedTenBit?: boolean;
}

/** Device frames back to the CPU, keeping their bit depth. */
function download(tenBit: boolean): string[] {
  return ["hwdownload", `format=${tenBit ? "p010le" : "nv12"}`];
}

/** The device filter's size options, or none to keep the size. */
function size(width: number | null, height: number | null, w = "w", h = "h"): string[] {
  return width !== null && height !== null ? [`${w}=${width}`, `${h}=${height}`] : [];
}

/** Joins a filter's name and options, as `name=a:b`, or just the name. */
function filter(name: string, options: string[]): string {
  return options.length > 0 ? `${name}=${options.join(":")}` : name;
}

/** SDR BT.709 as the tone mappers name it, with the BT.2390 curve. */
const TONE_MAP_TARGET = "t=bt709:m=bt709:p=bt709";

const DEVICES: Record<Exclude<HardwareApi, "none">, Device> = {
  videotoolbox: {
    encoder: "h264_videotoolbox",
    decode: () => ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"],
    framesOnDevice: true,
    encodeOnly: () => [],
    scale: (width, height, format) => filter("scale_vt", [...size(width, height), `format=${format === "p010" ? "p010le" : "nv12"}`]),
    toneMap: `tonemap_videotoolbox=format=nv12:${TONE_MAP_TARGET}:tonemap=bt2390`,
    upload: ["format=yuv420p"],
  },
  qsv: {
    encoder: "h264_qsv",
    // Decoded by VA-API on the same GPU and mapped into Quick Sync for its filters and encoder, as on Linux
    decode: (settings) => [
      "-init_hw_device", `vaapi=va:${settings.vaapiDevice}`, "-init_hw_device", "qsv=qs@va", "-filter_hw_device", "qs",
      "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi",
    ],
    framesOnDevice: true,
    enter: "hwmap=derive_device=qsv",
    encodeOnly: () => [],
    scale: (width, height, format) => filter("vpp_qsv", [...size(width, height), `format=${format}`]),
    toneMap: "vpp_qsv=tonemap=1:format=nv12",
    upload: ["format=nv12"],
  },
  vaapi: {
    encoder: "h264_vaapi",
    // A named device, so frames uploaded after CPU filters reach the same one
    decode: (settings) => ["-init_hw_device", `vaapi=va:${settings.vaapiDevice}`, "-filter_hw_device", "va", "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"],
    framesOnDevice: true,
    encodeOnly: (settings) => ["-vaapi_device", settings.vaapiDevice],
    scale: (width, height, format) => filter("scale_vaapi", [...size(width, height), `format=${format}`]),
    // Intel's driver only; AMD's fails, which the probe finds out
    toneMap: `tonemap_vaapi=format=nv12:${TONE_MAP_TARGET}`,
    upload: ["format=nv12", "hwupload"],
  },
  nvenc: {
    encoder: "h264_nvenc",
    decode: () => ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
    framesOnDevice: true,
    encodeOnly: () => [],
    scale: (width, height, format) => filter("scale_cuda", [...size(width, height), `format=${format === "p010" ? "p010le" : "nv12"}`]),
    toneMap: `tonemap_cuda=format=nv12:${TONE_MAP_TARGET}:tonemap=bt2390`,
    upload: ["format=yuv420p"],
  },
  rkmpp: {
    encoder: "h264_rkmpp",
    decode: () => ["-hwaccel", "rkmpp", "-hwaccel_output_format", "drm_prime"],
    // OpenCL on the Mali GPU, derived from the decoder's device so frames are shared rather than copied
    toneMapDecode: () => [
      "-init_hw_device", "rkmpp=rk", "-init_hw_device", "opencl=ocl@rk", "-filter_hw_device", "ocl",
      "-hwaccel", "rkmpp", "-hwaccel_device", "rk", "-hwaccel_output_format", "drm_prime",
    ],
    framesOnDevice: true,
    encodeOnly: () => [],
    // The RGA scales and converts, and the GPU tone maps the 10-bit frames it hands over, which go back to the encoder as DRM frames
    scale: (width, height, format) => filter("scale_rkrga", [...size(width, height), `format=${format}`]),
    toneMap: [
      "hwmap=derive_device=opencl:mode=read",
      `tonemap_opencl=format=nv12:${TONE_MAP_TARGET}:tonemap=bt2390:peak=100:desat=0`,
      "hwmap=derive_device=rkmpp:mode=write:reverse=1",
      "format=drm_prime",
    ].join(","),
    upload: ["format=yuv420p"],
    packedTenBit: true,
  },
  amf: {
    encoder: "h264_amf",
    // Direct3D 11 decodes into system memory here, so filters run on the CPU
    decode: () => ["-hwaccel", "d3d11va"],
    framesOnDevice: false,
    encodeOnly: () => [],
    scale: () => null,
    toneMap: null,
    upload: ["format=yuv420p"],
  },
};

/**
 * HDR (PQ or HLG) to SDR BT.709 with zscale: linearise, map the highlights
 * down with Hable's curve, then convert to BT.709 primaries and transfer.
 * The fallback when ffmpeg lacks `tonemapx`; many times slower.
 */
const ZSCALE_TONE_MAP = ["zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv"];

// ---------- Pipeline ---------- //

export class TranscodePipeline {
  /** The H.264 encoder an API uses. */
  public static encoderName(api: HardwareApi): string {
    return api === "none" ? "libx264" : DEVICES[api].encoder;
  }

  /** Whether an API has a scaler and a tone mapper of its own, whether or not they work on this machine. */
  public static deviceFilters(api: HardwareApi): { scales: boolean; toneMaps: boolean } {
    if (api === "none") return { scales: false, toneMaps: false };
    const device = DEVICES[api];
    return { scales: device.framesOnDevice && device.scale(null, null, "nv12") !== null, toneMaps: device.framesOnDevice && device.toneMap !== null };
  }

  /** Whether an API can run the `device` rung for this transcode: its decoder and the device filters it needs. */
  public static deviceRungPossible(api: HardwareApi, encode: VideoEncode, source: TranscodeSource): boolean {
    if (api === "none") return false;
    const device = DEVICES[api];
    if (!device.framesOnDevice) return false;
    if (encode.toneMap && device.toneMap === null) return false;
    const converts = encode.scaleToHeight !== null || source.bitDepth > 8;
    return !converts || device.scale(null, null, "nv12") !== null;
  }

  /**
   * Arguments that decode on `api` and bring the frames back to the CPU.
   * Downloading fails on frames that never reached the device, so a decoder
   * that quietly fell back to software can't pass for a hardware one.
   */
  public static decodeCheck(api: HardwareApi, tenBit: boolean, settings: PlaybackSettings): { input: string[]; filters: string[] } | null {
    if (api === "none") return null;
    const device = DEVICES[api];
    return { input: device.decode(settings), filters: device.framesOnDevice ? this.download(device, tenBit) : [] };
  }

  /** The width that keeps the source's shape at `height`, rounded to an even number. */
  public static widthFor(source: TranscodeSource, height: number): number {
    return Math.max(2, Math.round((source.width * height) / source.height / 2) * 2);
  }

  /**
   * The video arguments for `rung` on `api`. A rung the API can't run is
   * built as the next one down, so the result's `rung` says which was built.
   * `deviceScales` says whether the `decode` rung may scale on the device,
   * as the hardware checks found; otherwise it scales on the CPU.
   */
  public static build(
    api: HardwareApi,
    rung: Rung,
    encode: VideoEncode,
    source: TranscodeSource,
    settings: PlaybackSettings,
    available: FilterSet,
    deviceScales = true,
  ): VideoArgs {
    if (api === "none" || rung === "cpu") return this.cpu(encode, settings, available);
    const device = DEVICES[api];
    if (rung === "device" && !this.deviceRungPossible(api, encode, source)) rung = "decode";

    const tenBit = source.bitDepth > 8;
    const width = encode.scaleToHeight === null ? null : this.widthFor(source, encode.scaleToHeight);
    const height = encode.scaleToHeight;
    const chain: string[] = [];
    let input: string[];

    if (rung === "device") {
      input = encode.toneMap && device.toneMapDecode ? device.toneMapDecode(settings) : device.decode(settings);
      if (device.enter) chain.push(device.enter);
      if (encode.toneMap) {
        // Scaled first, still 10-bit, so the tone mapper has the smaller picture; it hands back 8-bit SDR.
        // Packed 10-bit frames pass through the scaler even unscaled, as the tone mapper can't read them either
        if (height !== null || device.packedTenBit) chain.push(device.scale(width, height, "p010") ?? "");
        chain.push(device.toneMap ?? "");
      } else if (height !== null || tenBit) {
        // Scaled and dropped to 8-bit in one pass
        chain.push(device.scale(width, height, "nv12") ?? "");
      }
    } else if (rung === "decode") {
      // Decoded on the device and scaled there when it can, keeping 10-bit for the CPU's tone mapping
      input = device.decode(settings);
      const keepTenBit = tenBit && encode.toneMap;
      const scaled = device.framesOnDevice && deviceScales && height !== null ? device.scale(width, height, keepTenBit ? "p010" : "nv12") : null;
      if (scaled) chain.push(...(device.enter ? [device.enter] : []), scaled);
      if (device.framesOnDevice) chain.push(...(scaled ? download(keepTenBit) : this.download(device, tenBit)));
      if (encode.toneMap) chain.push(...this.cpuToneMap(available, scaled ? null : height));
      else if (!scaled && height !== null) chain.push(`scale=-2:${height}`);
      chain.push(...device.upload);
    } else {
      // Decoded and filtered on the CPU, encoded on the device
      input = device.encodeOnly(settings);
      if (encode.toneMap) chain.push(...this.cpuToneMap(available, height));
      else if (height !== null) chain.push(`scale=-2:${height}`);
      chain.push(...device.upload);
    }

    const output = ["-c:v", device.encoder];
    // A device filter the API lacks was ruled out by `deviceRungPossible`; never pass an empty one on
    const filters = chain.filter((step) => step !== "");
    if (filters.length > 0) output.push("-vf", filters.join(","));
    output.push(...this.rateControl(api, encode, settings), ...this.keyframes(encode));
    return { input, output, rung, encoder: device.encoder };
  }

  // ---------- Building blocks ---------- //

  /** Decoded frames back to the CPU at their bit depth, through the device's scaler first where they can't be downloaded as decoded. */
  private static download(device: Device, tenBit: boolean): string[] {
    const convert = tenBit && device.packedTenBit ? device.scale(null, null, "p010") : null;
    return [...(convert ? [convert] : []), ...download(tenBit)];
  }

  /** x264 on the CPU. */
  private static cpu(encode: VideoEncode, settings: PlaybackSettings, filters: FilterSet): VideoArgs {
    const chain = encode.toneMap ? this.cpuToneMap(filters, encode.scaleToHeight) : encode.scaleToHeight !== null ? [`scale=-2:${encode.scaleToHeight}`] : [];
    chain.push("format=yuv420p");
    const output = ["-c:v", "libx264", "-vf", chain.join(","), ...this.rateControl("none", encode, settings), ...this.keyframes(encode)];
    if (settings.threads > 0) output.push("-threads", String(settings.threads));
    return { input: [], output, rung: "cpu", encoder: "libx264" };
  }

  /**
   * HDR to SDR on the CPU, scaling to `height` too when given: `tonemapx`
   * (SIMD, jellyfin-ffmpeg) after scaling, else zscale before it, else just
   * the scale when ffmpeg has neither, which leaves HDR washed out.
   */
  private static cpuToneMap(filters: FilterSet, height: number | null): string[] {
    const scale = height !== null ? [`scale=-2:${height}`] : [];
    if (filters.has("tonemapx")) return [...scale, `tonemapx=tonemap=bt2390:${TONE_MAP_TARGET}:format=yuv420p`];
    if (filters.has("zscale") && filters.has("tonemap")) return [...ZSCALE_TONE_MAP, ...scale];
    return scale;
  }

  /** Rate control: quality-based unless capped, in each encoder's own terms. */
  private static rateControl(api: HardwareApi, encode: VideoEncode, settings: PlaybackSettings): string[] {
    const crf = String(settings.h264Crf);
    const cap = encode.bitrateCap;
    const capped = cap === null ? [] : ["-maxrate", String(cap), "-bufsize", String(cap * 2)];
    switch (api) {
      case "none":
        return ["-preset", settings.encoderPreset, "-profile:v", "high", "-crf", crf, ...capped];
      case "videotoolbox":
        // Its own keyframe interval defaults to 12 frames; only the forced ones are wanted
        return ["-profile:v", "high", "-allow_sw", "1", "-b:v", String(cap ?? encode.bitrateEstimate), "-g", "9999"];
      case "nvenc":
        return ["-preset", "p4", "-profile:v", "high", "-rc", "vbr", "-cq", crf, "-b:v", "0", ...capped, "-forced-idr", "1"];
      case "qsv":
        return ["-preset", "veryfast", "-profile:v", "high", "-look_ahead", "0", "-forced_idr", "1", ...(cap === null ? ["-global_quality", crf] : ["-b:v", String(cap), ...capped])];
      case "vaapi":
        return cap === null ? ["-rc_mode", "CQP", "-qp", crf] : ["-rc_mode", "VBR", "-b:v", String(cap), ...capped];
      case "amf":
        return ["-quality", "speed", ...(cap === null ? ["-rc", "cqp", "-qp_i", crf, "-qp_p", crf] : ["-rc", "vbr_peak", "-b:v", String(cap), ...capped])];
      case "rkmpp":
        return cap === null ? ["-rc_mode", "CQP", "-qp_init", crf] : ["-rc_mode", "VBR", "-b:v", String(cap), ...capped];
    }
  }

  /** A keyframe every `keyframeSeconds` from the start of the run, and no B-frames. */
  private static keyframes(encode: VideoEncode): string[] {
    return ["-bf", "0", "-force_key_frames", `expr:gte(t,n_forced*${encode.keyframeSeconds})`, "-sc_threshold", "0"];
  }
}
