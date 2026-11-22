/**
 * Works out what stops this machine playing as well as it could, and says
 * how to fix each thing: hardware that isn't used or doesn't work, devices a
 * container can't reach, stages of a transcode left on the CPU, too little
 * room or memory, and what in the library will need converting.
 *
 * It reads the hardware check (`HardwareProbe`), the transcodes that have
 * fallen back since, and a few facts about the system (device files, the
 * device tree, OpenCL drivers, cores, memory, free space). The judging itself
 * is `evaluate`, pure, so every check is tested as a table.
 */

import { constants } from "node:fs";
import { access, lstat, readdir, readFile, stat, statfs } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import type { DecodeKind, DiagnosticLevel, HardwareReport, PlaybackDiagnostic, PlaybackDiagnostics as Diagnostics, PlaybackSettings } from "@findr/types/playback";
import { MediaItem } from "../db/models/MediaItem";
import { Container } from "../env/Container";
import { Ffmpeg } from "./Ffmpeg";
import HardwareProbe, { decodeKind } from "./HardwareProbe";
import type { ProbeInfo } from "./MediaProbe";
import { AUDIO_CODECS } from "./PlaybackDecider";
import PlaybackService from "./PlaybackService";
import { type FilterSet, type Rung, TranscodePipeline } from "./TranscodePipeline";

// ---------- Facts ---------- //

/** Whether a device file exists and Findr's user can open it, and the group that owns it. */
export interface DeviceAccess {
  state: "ok" | "denied" | "missing";
  /** The owning group's id, for `group_add`; null when missing. */
  group: number | null;
}

/** What the checks need to know about the machine. */
export interface SystemFacts {
  platform: NodeJS.Platform;
  arch: string;
  /** Whether Findr runs in a container, where devices and drivers have to be passed in. */
  container: boolean;
  cpuCount: number;
  memoryBytes: number;
  /** Device files that hardware APIs open, by path; Linux only. */
  devices: Record<string, DeviceAccess>;
  /** The device tree's `compatible` list (`rockchip,rk3588`…); null when there is none or it can't be read. */
  soc: string | null;
  /** Whether the device tree exists but can't be read, as under Docker's default AppArmor profile. */
  deviceTreeHidden: boolean;
  /** OpenCL drivers registered in `/etc/OpenCL/vendors`. */
  openclDrivers: number;
  /** Where transcodes are written, or null when no path is set. */
  transcodesPath: string | null;
  /** Free bytes there, or null when unknown. */
  transcodesFreeBytes: number | null;
}

/** What the library holds, as far as playing it on typical devices goes. */
export interface LibraryFacts {
  files: number;
  /** Files with HDR video. */
  hdr: number;
  /** Files by the decode kind of their video. */
  kinds: Partial<Record<DecodeKind, number>>;
  /** Files whose default audio no device takes as it is (DTS, TrueHD, PCM…), converted on every play. */
  audioConverted: number;
}

/** A kind of transcode that fell back to a lower rung since the hardware was last checked. */
export interface Fallback {
  key: string;
  rungs: Rung[];
}

/** Everything `evaluate` judges. */
export interface DiagnosticInputs {
  settings: PlaybackSettings;
  /** What the hardware check found, or null without ffmpeg. */
  report: HardwareReport | null;
  ffmpeg: boolean;
  filters: FilterSet;
  system: SystemFacts;
  library: LibraryFacts;
  fallbacks: Fallback[];
}

// ---------- Constants ---------- //

/** Rockchip's device files, in the order a compose file lists them. */
const ROCKCHIP_DEVICES = ["/dev/dri", "/dev/dma_heap", "/dev/mpp_service", "/dev/rga", "/dev/mali0"];

/** NVIDIA's device files, which the NVIDIA container runtime passes in. */
const NVIDIA_DEVICES = ["/dev/nvidia0", "/dev/nvidiactl"];

/** Below this much free space where transcodes go, a long 4K conversion can fill it. */
const LOW_SPACE_BYTES = 5 * 1024 ** 3;

/** Below this much memory, the CPU tone mapper and several sessions crowd each other out. */
const LOW_MEMORY_BYTES = 2 * 1024 ** 3;

/** How to get an ffmpeg with `tonemapx`. */
const BUNDLED_FFMPEG = "Run a release executable or the Docker image, whose built-in ffmpeg (jellyfin-ffmpeg) has the fast `tonemapx`, and leave `FFMPEG_PATH` unset so Findr uses it.";

/** Order of the levels, worst first. */
const LEVEL_ORDER: Record<DiagnosticLevel, number> = { problem: 0, slower: 1, note: 2 };

/** Decode kinds as people name them. */
const KIND_NAMES: Record<DecodeKind, string> = {
  h264: "H.264",
  hevc: "HEVC",
  hevc10: "10-bit HEVC",
  av1: "AV1",
  av1_10: "10-bit AV1",
  vp9: "VP9",
  vp9_10: "10-bit VP9",
};

/** The hardware APIs by their product names. */
const API_NAMES: Record<HardwareReport["api"], string> = {
  none: "the CPU",
  videotoolbox: "VideoToolbox",
  nvenc: "NVENC",
  qsv: "Quick Sync",
  vaapi: "VA-API",
  amf: "AMF",
  rkmpp: "Rockchip MPP",
};

/** The ladder's rungs as Now playing words them. */
const RUNG_NAMES: Record<Rung, string> = {
  device: "all on hardware",
  decode: "decoded on hardware",
  encode: "encoded on hardware",
  cpu: "the CPU",
};

// ---------- Diagnostics ---------- //

export class PlaybackDiagnostics {
  /** Gathers the facts and judges them; `refresh` checks the hardware again first. */
  public static async run(settings: PlaybackSettings, refresh = false): Promise<Diagnostics> {
    const ffmpeg = await Ffmpeg.available();
    const report = ffmpeg && settings.enabled ? await HardwareProbe.getInstance().report(settings, refresh) : null;
    const items = this.evaluate({
      settings,
      report,
      ffmpeg,
      filters: Ffmpeg.filterNames,
      system: await this.gatherSystem(settings),
      library: this.summariseLibrary(MediaItem.probes()),
      fallbacks: HardwareProbe.getInstance().fallbacks(),
    });
    return { hardware: report, items, checkedAt: Date.now() };
  }

  /** Every check, worst first. */
  public static evaluate(inputs: DiagnosticInputs): PlaybackDiagnostic[] {
    const items = [
      ...this.checkTools(inputs),
      ...this.checkDevices(inputs),
      ...this.checkHardware(inputs),
      ...this.checkStages(inputs),
      ...this.checkCapacity(inputs),
      ...this.checkHistory(inputs),
      ...this.checkLibrary(inputs),
    ];
    return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  }

  /** Counts what in the library will need converting. */
  public static summariseLibrary(probes: ProbeInfo[]): LibraryFacts {
    const facts: LibraryFacts = { files: probes.length, hdr: 0, kinds: {}, audioConverted: 0 };
    for (const probe of probes) {
      if (probe.video.hdr) facts.hdr++;
      const kind = decodeKind(probe.video.codec, probe.video.bitDepth);
      if (kind) facts.kinds[kind] = (facts.kinds[kind] ?? 0) + 1;
      const audio = probe.audio.find((track) => track.isDefault) ?? probe.audio[0];
      if (audio && AUDIO_CODECS[audio.codec] === undefined) facts.audioConverted++;
    }
    return facts;
  }

  // ---------- Checks ---------- //

  /** ffmpeg itself, its tone mappers, and whether converting is allowed at all. */
  private static checkTools({ settings, ffmpeg, filters, library }: DiagnosticInputs): PlaybackDiagnostic[] {
    const items: PlaybackDiagnostic[] = [];
    if (!ffmpeg) {
      items.push(item("ffmpeg_missing", "problem", "ffmpeg isn't available", "Without ffmpeg nothing can be indexed, remuxed or converted, so nothing plays.", "Use the Docker image or a release executable, which carry their own ffmpeg, or install ffmpeg and ffprobe and set `FFMPEG_PATH` and `FFPROBE_PATH`."));
      return items;
    }
    if (!settings.transcoding) {
      items.push(item("transcoding_off", "note", "Converting video is turned off", "Files play only on devices that take their video as it is; anything else, such as HDR on an SDR screen or HEVC in Firefox, won't play.", "Turn on Transcoding under Playback if devices report files they can't play."));
    }
    if (!settings.toneMapping) {
      items.push(item("tone_mapping_off", "note", "HDR tone mapping is turned off", "HDR video converted for an SDR screen will look grey and washed out.", "Turn on Tone mapping under Playback."));
    } else if (!filters.has("tonemapx")) {
      const zscale = filters.has("zscale") && filters.has("tonemap");
      items.push(
        zscale
          ? item("tone_map_slow_cpu", "slower", "This ffmpeg lacks the fast CPU tone mapper", `HDR converted on the CPU uses zscale, several times slower than \`tonemapx\`${count(library.hdr, "HDR file")}.`, BUNDLED_FFMPEG)
          : item("tone_map_missing", "problem", "This ffmpeg can't tone map HDR", `HDR converted for SDR screens looks grey and washed out${count(library.hdr, "HDR file")}.`, BUNDLED_FFMPEG),
      );
    }
    return items;
  }

  /** Device files a container hasn't been given, or Findr's user can't open, and Rockchip's hidden device tree. */
  private static checkDevices({ system, report }: DiagnosticInputs): PlaybackDiagnostic[] {
    if (system.platform !== "linux") return [];
    const items: PlaybackDiagnostic[] = [];
    const rockchip = isRockchip(system);

    // Present but closed to Findr's user: add the owning groups
    const denied = Object.entries(system.devices).filter(([, access]) => access.state === "denied");
    if (denied.length > 0) {
      const groups = [...new Set(denied.map(([, access]) => access.group).filter((group): group is number => group !== null))];
      items.push(
        item(
          "devices_denied",
          "problem",
          "Findr can't open the graphics devices",
          `${listOf(denied.map(([path]) => `\`${path}\``))} ${denied.length === 1 ? "exists" : "exist"} but Findr's user isn't allowed to open ${denied.length === 1 ? "it" : "them"}, so the hardware goes unused.`,
          system.container ? "Add the groups that own them to the container." : "Add Findr's user to the groups that own them, then restart Findr.",
          system.container && groups.length > 0 ? `group_add:\n${groups.map((group) => `  - "${group}"`).join("\n")}` : groups.length > 0 ? groups.map((group) => `sudo usermod -aG $(getent group ${group} | cut -d: -f1) $USER`).join("\n") : null,
        ),
      );
    }

    if (rockchip) {
      // Docker's AppArmor profile hides the device tree, and MPP can't tell which chip it is on without it
      if (system.container && system.deviceTreeHidden) {
        items.push(
          item(
            "rockchip_device_tree_hidden",
            "problem",
            "Rockchip's decoder can't identify the chip inside this container",
            "Docker hides the device tree from containers by default. Rockchip's MPP reads it to learn which chip it runs on, and without it won't decode HEVC, AV1 or VP9, so converting them decodes on the CPU and HDR can't be tone mapped on the GPU.",
            "Let the container read the device tree, as Jellyfin's Rockchip setup does, then recreate it.",
            "security_opt:\n  - systempaths=unconfined\n  - apparmor=unconfined",
          ),
        );
      }

      // Rockchip's devices the container wasn't given; on the host, a mainline kernel lacks MPP altogether
      const missing = ROCKCHIP_DEVICES.filter((path) => system.devices[path]?.state === "missing" && path !== "/dev/mali0");
      if (missing.length > 0) {
        items.push(
          system.container
            ? item("rockchip_devices_missing", "problem", "The container hasn't been given Rockchip's devices", `${listOf(missing.map((path) => `\`${path}\``))} ${missing.length === 1 ? "is" : "are"} missing inside the container, so ${missing.includes("/dev/mpp_service") ? "nothing is decoded or encoded" : "scaling can't run"} on the hardware.`, "Pass every one of them through, then recreate the container.", devicesSnippet(ROCKCHIP_DEVICES))
            : item("rockchip_kernel", "problem", "This kernel has no Rockchip video driver", `${listOf(missing.map((path) => `\`${path}\``))} ${missing.length === 1 ? "doesn't" : "don't"} exist. Mainline kernels lack Rockchip's MPP driver, so the board's encoder can't be used.`, "Run a board image with Rockchip's own (BSP) kernel, 5.10 or 6.1, such as Ubuntu Rockchip or Armbian's vendor kernel."),
        );
      }
    }

    // NVIDIA's devices only reach a container through its runtime
    if (system.container && report?.configured === "nvenc" && NVIDIA_DEVICES.every((path) => system.devices[path]?.state === "missing")) {
      items.push(
        item(
          "nvidia_runtime",
          "problem",
          "The container can't see the NVIDIA card",
          "NVENC is chosen, but the NVIDIA driver's devices aren't in the container, so conversions run on the CPU.",
          "Install the NVIDIA Container Toolkit on the host and give the container the GPU with video capabilities.",
          "runtime: nvidia\nenvironment:\n  - NVIDIA_VISIBLE_DEVICES=all\n  - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility",
        ),
      );
    }
    return items;
  }

  /** Whether hardware is chosen, found and working. */
  private static checkHardware({ settings, report, system }: DiagnosticInputs): PlaybackDiagnostic[] {
    if (!report) return [];
    const present = hardwarePresent(system);

    // Off by choice while the machine has hardware
    if (settings.hardwareAcceleration === "none") {
      return present ? [item("hardware_off", "slower", "Hardware acceleration is off", `This machine has ${present}, but every conversion runs on the CPU, which is slower and uses far more power.`, "Set Hardware acceleration under Playback to Automatic, then test the hardware.")] : [];
    }

    // Chosen but nothing works: say why when the system shows it
    if (report.api === "none") {
      if (settings.hardwareAcceleration === "auto" && !present) {
        return [item("hardware_none", "note", "No graphics hardware found", "Conversions run on the CPU with x264. That works, but a few at once can use every core.", null)];
      }
      return [
        item(
          "hardware_failed",
          "problem",
          `${settings.hardwareAcceleration === "auto" ? "No hardware encoder" : API_NAMES[settings.hardwareAcceleration]} works here`,
          `Conversions fall back to the CPU, which is much slower.${report.message ? ` ffmpeg said: ${report.message}` : ""}`,
          system.container ? "Check that the container has the graphics devices and the groups that own them; the items above say what's missing." : "Check that the graphics driver is installed and Findr's user can open its devices, then test the hardware again.",
        ),
      ];
    }
    return [];
  }

  /** Stages of a conversion the hardware could do but doesn't: decoding, scaling, tone mapping. */
  private static checkStages({ settings, report, system, library }: DiagnosticInputs): PlaybackDiagnostic[] {
    if (!report || report.api === "none" || !report.encodes) return [];
    const items: PlaybackDiagnostic[] = [];
    const api = API_NAMES[report.api];
    const filters = TranscodePipeline.deviceFilters(report.api);

    // Decoders: say which kinds the library holds that are decoded on the CPU
    const undecoded = (Object.keys(KIND_NAMES) as DecodeKind[]).filter((kind) => !report.decodes.includes(kind) && (library.kinds[kind] ?? 0) > 0);
    if (report.decodes.length === 0 && !hiddenRockchip(system)) {
      items.push(item("decode_none", "slower", `${api} encodes but doesn't decode anything`, "Every conversion decodes on the CPU before the hardware encodes it, which takes a few cores per stream.", report.message ? `ffmpeg said: ${report.message}` : null));
    } else if (report.decodes.length > 0 && undecoded.length > 0 && !hiddenRockchip(system)) {
      const files = undecoded.reduce((sum, kind) => sum + (library.kinds[kind] ?? 0), 0);
      items.push(item("decode_partial", "slower", `Some video is decoded on the CPU`, `${api} doesn't decode ${listOf(undecoded.map((kind) => KIND_NAMES[kind]))} here, so converting ${files === 1 ? "that file" : `those ${files} files`} decodes on the CPU.`, "Newer graphics decode more formats. Nothing in Findr's settings changes this."));
    }

    // The device's scaler, when it has one
    if (filters.scales && report.decodes.length > 0 && !report.scales) {
      const said = stageMessage(report, "scaling");
      items.push(item("scale_cpu", "slower", "Resizing runs on the CPU", `${api} decodes here but its scaler failed, so video made smaller for a device is resized on the CPU, and HDR is tone mapped there too.`, said ? `ffmpeg said: ${said}` : null));
    }

    // Tone mapping: the commonest gap, with the reason when the system shows it
    if (settings.toneMapping && !report.toneMaps && report.decodes.includes("hevc10")) {
      items.push(this.toneMapItem(report, system, library, filters.toneMaps));
    }
    return items;
  }

  /** Why HDR is tone mapped on the CPU, and what would move it onto the hardware. */
  private static toneMapItem(report: HardwareReport, system: SystemFacts, library: LibraryFacts, hasToneMapper: boolean): PlaybackDiagnostic {
    const title = "HDR is tone mapped on the CPU";
    const cost = `Converting HDR for an SDR screen decodes and encodes on ${API_NAMES[report.api]}, but maps the picture on the CPU, which takes several cores per stream${count(library.hdr, "HDR file")}.`;
    const message = stageMessage(report, "tone mapping") ?? "";

    // Tone mapping is only tried on frames the device scaled, so a failed scaler stops it first
    if (hasToneMapper && !report.scales) {
      return item("tone_map_cpu", "slower", title, `${cost} Tone mapping on the hardware wasn't tried, because scaling there failed first.`, "Fix scaling first; the item about resizing says what failed.");
    }

    if (report.api === "rkmpp") {
      const mali = system.devices["/dev/mali0"];
      if (mali?.state === "missing") {
        return item("tone_map_gpu_device", "slower", title, `${cost} Rockchip boards tone map on the Mali GPU through OpenCL, but \`/dev/mali0\` ${system.container ? "hasn't been passed into the container" : "doesn't exist; the kernel's Mali driver isn't loaded"}.`, system.container ? "Pass the GPU through too, then recreate the container." : "Use a board image whose kernel has the Mali (bifrost) driver.", system.container ? devicesSnippet(["/dev/mali0"]) : null);
      }
      if (system.openclDrivers === 0) {
        return item("tone_map_gpu_driver", "slower", title, `${cost} Rockchip boards tone map on the Mali GPU through OpenCL, but no OpenCL driver is installed${system.container ? " in this image" : ""}.`, system.container ? "Pull the latest Findr image, which carries the Mali OpenCL driver for arm64." : "Install the Mali G610 OpenCL driver (libmali, the GBM or Wayland build) so it registers in /etc/OpenCL/vendors.");
      }
      if (/base context|kernel driver|-19|No such device/i.test(message)) {
        return item("tone_map_gpu_firmware", "slower", title, `${cost} The Mali GPU's firmware failed to load, which happens when it is first used long after boot and memory has become fragmented.`, "Restart the machine. Findr opens the GPU as soon as it starts, so started at boot (restart: unless-stopped) it loads the firmware before memory fragments. Then test the hardware again.");
      }
    }
    if (!hasToneMapper) {
      return item("tone_map_cpu", "note", title, `${cost} ${API_NAMES[report.api]} has no tone mapper of its own.`, null);
    }
    const amd = report.api === "vaapi" && /radeon|amdgpu|mesa/i.test(message);
    return item("tone_map_cpu", "slower", title, `${cost}${amd ? " AMD's VA-API driver can't tone map." : ""}`, message ? `ffmpeg said: ${message}` : null);
  }

  /** Cores, memory, room for transcodes, and NVIDIA's limit on encodes. */
  private static checkCapacity({ report, system }: DiagnosticInputs): PlaybackDiagnostic[] {
    const items: PlaybackDiagnostic[] = [];
    if (report?.api === "none" && system.cpuCount <= 4) {
      items.push(item("cpu_few_cores", "slower", `Only ${system.cpuCount} CPU cores and no hardware encoder`, "A 1080p conversion on the CPU takes most of this machine, so a second at once may stutter.", "Lower Max transcode resolution under Playback, or use a machine with a hardware encoder."));
    }
    if (system.memoryBytes > 0 && system.memoryBytes < LOW_MEMORY_BYTES) {
      items.push(item("memory_low", "note", `Only ${(system.memoryBytes / 1024 ** 3).toFixed(1)} GB of memory`, "Several conversions at once, with downloads running, may run short.", null));
    }
    if (system.transcodesPath === null) {
      items.push(item("transcodes_path", "problem", "There's nowhere to write conversions", "Neither a transcodes path nor a downloads path is set, so nothing can be converted or remuxed.", "Set the downloads path under Paths, or a transcodes path under Playback."));
    } else if (system.transcodesFreeBytes !== null && system.transcodesFreeBytes < LOW_SPACE_BYTES) {
      items.push(item("transcodes_space", "problem", "Little room left for conversions", `Only ${(system.transcodesFreeBytes / 1024 ** 3).toFixed(1)} GB is free at \`${system.transcodesPath}\`. A long 4K stream can fill that, and playback stops when it does.`, "Free some space there, or point the transcodes path under Playback at a larger disk."));
    }
    if (report?.api === "nvenc") {
      items.push(item("nvenc_sessions", "note", "NVIDIA consumer cards limit encodes", "GeForce cards run only a few NVENC encodes at once (8 on recent drivers); past that a conversion falls back to the CPU.", null));
    }
    return items;
  }

  /** Conversions that fell back to a lower rung since the hardware was checked. */
  private static checkHistory({ fallbacks, report }: DiagnosticInputs): PlaybackDiagnostic[] {
    if (fallbacks.length === 0 || !report || report.api === "none") return [];
    const lines = fallbacks.map(({ key, rungs }) => `${describeKey(key)}: ${listOf(rungs.map((rung) => RUNG_NAMES[rung]))} failed`);
    return [
      item(
        "fallbacks",
        "slower",
        `${fallbacks.length === 1 ? "A kind of conversion" : `${fallbacks.length} kinds of conversion`} fell back to a slower way`,
        `Since the hardware was last checked, ${lines.join("; ")}. ${fallbacks.length === 1 ? "It now starts" : "They now start"} lower down until the hardware is tested again; the log has ffmpeg's reasons.`,
        "Test the hardware again after changing anything, so Findr tries the faster way again.",
      ),
    ];
  }

  /** What the library holds that needs converting on most devices. */
  private static checkLibrary({ library }: DiagnosticInputs): PlaybackDiagnostic[] {
    if (library.audioConverted === 0) return [];
    const one = library.audioConverted === 1;
    return [
      item(
        "audio_converted",
        "note",
        `${library.audioConverted} ${one ? "file has" : "files have"} audio no device plays as it is`,
        `${one ? "Its" : "Their"} default audio is DTS, TrueHD or similar, so it's converted to AAC on every play, which takes some CPU alongside the video and means ${one ? "it" : "they"} can't be sent untouched.`,
        null,
      ),
    ];
  }

  // ---------- System ---------- //

  /** Reads the facts the checks need from this machine. */
  private static async gatherSystem(settings: PlaybackSettings): Promise<SystemFacts> {
    const transcodesPath = PlaybackService.getInstance().scratchRootOrNull(settings);
    const devices: Record<string, DeviceAccess> = {};
    if (process.platform === "linux") {
      const paths = [...new Set([...ROCKCHIP_DEVICES, settings.vaapiDevice, ...NVIDIA_DEVICES])];
      await Promise.all(paths.map(async (path) => (devices[path] = await deviceAccess(path))));
    }
    const tree = await deviceTree();
    return {
      platform: process.platform,
      arch: process.arch,
      container: Container.inside,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      devices,
      soc: tree.soc,
      deviceTreeHidden: tree.hidden,
      openclDrivers: await readdir("/etc/OpenCL/vendors").then((files) => files.filter((file) => file.endsWith(".icd")).length, () => 0),
      transcodesPath,
      transcodesFreeBytes: transcodesPath ? await freeBytes(transcodesPath) : null,
    };
  }
}

// ---------- Helpers ---------- //

/** What ffmpeg said when one stage of the hardware check failed (`scaling: …`), or null when that stage didn't fail. */
function stageMessage(report: HardwareReport, stage: string): string | null {
  const prefix = `${stage}: `;
  return report.message?.startsWith(prefix) ? report.message.slice(prefix.length) : null;
}

/** A diagnostic. */
function item(id: string, level: DiagnosticLevel, title: string, detail: string, fix: string | null, snippet: string | null = null): PlaybackDiagnostic {
  return { id, level, title, detail, fix, snippet };
}

/** Whether the machine looks like a Rockchip board: its device tree, or its video devices. */
function isRockchip(system: SystemFacts): boolean {
  const mpp = system.devices["/dev/mpp_service"];
  return Boolean(system.soc?.includes("rockchip")) || (mpp !== undefined && mpp.state !== "missing");
}

/** Whether Rockchip's decoder is known to fail for the hidden device tree, which its own item explains. */
function hiddenRockchip(system: SystemFacts): boolean {
  return system.container && system.deviceTreeHidden && isRockchip(system);
}

/** The graphics hardware the system shows, in words, or null for none. */
function hardwarePresent(system: SystemFacts): string | null {
  if (system.platform === "darwin") return "VideoToolbox";
  const exists = (path: string) => system.devices[path] !== undefined && system.devices[path].state !== "missing";
  if (exists("/dev/mpp_service")) return "Rockchip's video engine";
  if (NVIDIA_DEVICES.some(exists)) return "an NVIDIA card";
  if (Object.keys(system.devices).some((path) => path.startsWith("/dev/dri/render") && exists(path))) return "graphics that VA-API can use";
  return null;
}

/** A compose `devices:` list for these paths. */
function devicesSnippet(paths: string[]): string {
  return `devices:\n${paths.map((path) => `  - ${path}:${path}`).join("\n")}`;
}

/** " across the library's N files", or nothing for none. */
function count(files: number, noun: string): string {
  return files > 0 ? `, and the library has ${files} ${noun}${files === 1 ? "" : "s"}` : "";
}

/** "a, b and c". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A ladder key (`api|kind|scaled|toneMap`) in words, such as "10-bit HEVC resized and tone mapped". */
function describeKey(key: string): string {
  const [, kind = "", scaled, toneMap] = key.split("|");
  const name = KIND_NAMES[kind as DecodeKind] ?? kind;
  const steps = [scaled === "true" ? "resized" : null, toneMap === "true" ? "tone mapped" : null].filter(Boolean);
  return steps.length > 0 ? `${name} ${steps.join(" and ")}` : name;
}

/** Whether a device file exists and can be opened for reading and writing. */
async function deviceAccess(path: string): Promise<DeviceAccess> {
  const info = await stat(path).catch(() => null);
  if (!info) return { state: "missing", group: null };
  // A directory of devices (/dev/dri, /dev/dma_heap) only has to exist; its files are checked themselves
  if (info.isDirectory()) return { state: "ok", group: info.gid };
  const open = await access(path, constants.R_OK | constants.W_OK).then(() => true, () => false);
  return { state: open ? "ok" : "denied", group: info.gid };
}

/** The device tree's chip names, and whether it exists but can't be read. */
async function deviceTree(): Promise<{ soc: string | null; hidden: boolean }> {
  if (process.platform !== "linux") return { soc: null, hidden: false };
  const soc = await readFile("/proc/device-tree/compatible", "utf8").then((text) => text.split("\0").filter(Boolean).join(", "), () => null);
  if (soc !== null) return { soc, hidden: false };
  // The link into /sys/firmware is still there when a container masks what it points to
  return { soc: null, hidden: await lstat("/proc/device-tree").then(() => true, () => false) };
}

/** Free bytes on the disk holding `path` (or its nearest existing parent), or null when unknown. */
async function freeBytes(path: string): Promise<number | null> {
  let current = path;
  for (let depth = 0; depth < 32; depth++) {
    const info = await statfs(current).catch(() => null);
    if (info) return info.bavail * info.bsize;
    const parent = current.replace(/\/[^/]*\/?$/, "") || "/";
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
