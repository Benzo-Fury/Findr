import { describe, expect, test } from "bun:test";
import { type HardwareReport, PlaybackSettingsSchema } from "@findr/types/playback";
import { type DiagnosticInputs, type DeviceAccess, PlaybackDiagnostics, type SystemFacts } from "./PlaybackDiagnostics";
import type { ProbeInfo } from "./MediaProbe";

const settings = PlaybackSettingsSchema.parse({});
const ok: DeviceAccess = { state: "ok", group: 44 };
const missing: DeviceAccess = { state: "missing", group: null };

/** A Rockchip board's container, set up the way the docs say. */
const rockchipSystem: SystemFacts = {
  platform: "linux",
  arch: "arm64",
  container: true,
  cpuCount: 8,
  memoryBytes: 16 * 1024 ** 3,
  devices: { "/dev/dri": ok, "/dev/dma_heap": ok, "/dev/mpp_service": ok, "/dev/rga": ok, "/dev/mali0": ok, "/dev/dri/renderD128": ok, "/dev/nvidia0": missing, "/dev/nvidiactl": missing },
  soc: "xunlong,orangepi-5-plus, rockchip,rk3588",
  deviceTreeHidden: false,
  openclDrivers: 1,
  transcodesPath: "/media/downloads/.transcodes",
  transcodesFreeBytes: 500 * 1024 ** 3,
};

/** What the hardware check finds on that board with everything working. */
const rockchipReport: HardwareReport = {
  configured: "auto",
  api: "rkmpp",
  encoder: "h264_rkmpp",
  encodes: true,
  decodes: ["h264", "hevc", "hevc10", "av1", "av1_10", "vp9", "vp9_10"],
  scales: true,
  toneMaps: true,
  message: null,
  durationMs: 2000,
};

function inputs(overrides: Partial<DiagnosticInputs> = {}, system: Partial<SystemFacts> = {}): DiagnosticInputs {
  return {
    settings,
    report: rockchipReport,
    ffmpeg: true,
    filters: new Set(["tonemapx", "zscale", "tonemap"]),
    system: { ...rockchipSystem, ...system },
    library: { files: 10, hdr: 3, kinds: { hevc10: 3, h264: 7 }, audioConverted: 0 },
    fallbacks: [],
    ...overrides,
  };
}

/** The ids found, worst first. */
function ids(input: DiagnosticInputs): string[] {
  return PlaybackDiagnostics.evaluate(input).map((item) => item.id);
}

describe("PlaybackDiagnostics", () => {
  test("finds nothing on a fully working machine", () => {
    expect(ids(inputs())).toEqual([]);
  });

  test("explains Docker hiding the device tree from Rockchip's decoder, with the security options to add", () => {
    const items = PlaybackDiagnostics.evaluate(inputs({ report: { ...rockchipReport, decodes: [], scales: false, toneMaps: false } }, { soc: null, deviceTreeHidden: true }));
    expect(items.map((item) => item.id)).toEqual(["rockchip_device_tree_hidden"]);
    // H.264 still decodes there; the formats that don't are the same cause, so aren't listed again
    expect(ids(inputs({ report: { ...rockchipReport, decodes: ["h264"], toneMaps: false } }, { soc: null, deviceTreeHidden: true }))).toEqual(["rockchip_device_tree_hidden"]);
    expect(items[0]?.snippet).toContain("systempaths=unconfined");
    expect(items[0]?.snippet).toContain("apparmor=unconfined");
  });

  test("names why Rockchip's HDR tone mapping isn't on the GPU", () => {
    const report = { ...rockchipReport, toneMaps: false };
    expect(ids(inputs({ report }, { devices: { ...rockchipSystem.devices, "/dev/mali0": missing } }))).toEqual(["tone_map_gpu_device"]);
    expect(ids(inputs({ report }, { openclDrivers: 0 }))).toEqual(["tone_map_gpu_driver"]);
    const firmware = { ...report, message: "tone mapping: Failed creating base context during opening of kernel driver. Kernel module may not have been loaded" };
    expect(ids(inputs({ report: firmware }))).toEqual(["tone_map_gpu_firmware"]);
  });

  test("passes the missing Rockchip devices into the container, or blames the kernel on the host", () => {
    const devices = { ...rockchipSystem.devices, "/dev/mpp_service": missing, "/dev/rga": missing };
    const failed = { ...rockchipReport, api: "none" as const, encodes: false, decodes: [], scales: false, toneMaps: false };
    const inContainer = PlaybackDiagnostics.evaluate(inputs({ report: failed }, { devices }));
    expect(inContainer.map((item) => item.id)).toEqual(["rockchip_devices_missing", "hardware_failed"]);
    expect(inContainer[0]?.snippet).toContain("- /dev/mpp_service:/dev/mpp_service");
    expect(ids(inputs({ report: failed }, { devices, container: false }))).toEqual(["rockchip_kernel", "hardware_failed"]);
  });

  test("adds the owning groups for devices Findr can't open", () => {
    const items = PlaybackDiagnostics.evaluate(inputs({}, { devices: { ...rockchipSystem.devices, "/dev/rga": { state: "denied", group: 44 }, "/dev/dri/renderD128": { state: "denied", group: 992 } } }));
    expect(items[0]?.id).toBe("devices_denied");
    expect(items[0]?.snippet).toBe('group_add:\n  - "44"\n  - "992"');
  });

  test("suggests turning hardware on only where there is some", () => {
    const off = { ...settings, hardwareAcceleration: "none" as const };
    const cpu = { ...rockchipReport, configured: "none" as const, api: "none" as const, encoder: "libx264", decodes: [], scales: false, toneMaps: false };
    expect(ids(inputs({ settings: off, report: cpu }))).toEqual(["hardware_off"]);
    const bare = Object.fromEntries(Object.keys(rockchipSystem.devices).map((path) => [path, missing]));
    expect(ids(inputs({ settings: off, report: cpu }, { devices: bare, soc: null }))).toEqual([]);
    // Automatic, on a machine with nothing to find, is only worth a note
    expect(ids(inputs({ report: { ...cpu, configured: "auto" } }, { devices: bare, soc: null }))).toEqual(["hardware_none"]);
  });

  test("lists the library's formats the hardware doesn't decode", () => {
    const items = PlaybackDiagnostics.evaluate(inputs({ report: { ...rockchipReport, decodes: ["h264", "hevc"], toneMaps: false } }));
    expect(items.map((item) => item.id)).toEqual(["decode_partial"]);
    expect(items[0]?.detail).toContain("10-bit HEVC");
  });

  test("warns about slow or missing CPU tone mappers, and about tone mapping being off", () => {
    expect(ids(inputs({ filters: new Set(["zscale", "tonemap"]) }))).toEqual(["tone_map_slow_cpu"]);
    expect(ids(inputs({ filters: new Set() }))).toEqual(["tone_map_missing"]);
    expect(ids(inputs({ settings: { ...settings, toneMapping: false } }))).toEqual(["tone_mapping_off"]);
  });

  test("warns about space, memory, cores and NVIDIA's encode limit", () => {
    expect(ids(inputs({}, { transcodesFreeBytes: 1024 ** 3 }))).toEqual(["transcodes_space"]);
    expect(ids(inputs({}, { transcodesPath: null, transcodesFreeBytes: null }))).toEqual(["transcodes_path"]);
    expect(ids(inputs({}, { memoryBytes: 1024 ** 3 }))).toEqual(["memory_low"]);
    const cpu = { ...rockchipReport, configured: "auto" as const, api: "none" as const, encoder: "libx264", decodes: [], scales: false, toneMaps: false };
    const bare = Object.fromEntries(Object.keys(rockchipSystem.devices).map((path) => [path, missing]));
    expect(ids(inputs({ report: cpu }, { cpuCount: 4, devices: bare, soc: null }))).toEqual(["cpu_few_cores", "hardware_none"]);
    expect(ids(inputs({ report: { ...rockchipReport, api: "nvenc", encoder: "h264_nvenc" } }))).toContain("nvenc_sessions");
  });

  test("says which conversions fell back since the hardware was checked", () => {
    const items = PlaybackDiagnostics.evaluate(inputs({ fallbacks: [{ key: "rkmpp|hevc10|true|true", rungs: ["device"] }] }));
    expect(items.map((item) => item.id)).toEqual(["fallbacks"]);
    expect(items[0]?.detail).toContain("10-bit HEVC resized and tone mapped: all on hardware failed");
  });

  test("counts the library's HDR, formats and audio that needs converting", () => {
    const probe = (codec: string, bitDepth: number, hdr: boolean, audio: string): ProbeInfo => ({
      durationMs: 1,
      bitrate: 1,
      startTime: 0,
      video: { index: 0, codec, width: 1920, height: 1080, bitDepth, hdr },
      audio: [{ index: 1, codec: audio, channels: 6, language: null, title: null, isDefault: true }],
    });
    const facts = PlaybackDiagnostics.summariseLibrary([probe("hevc", 10, true, "truehd"), probe("h264", 8, false, "aac"), probe("hevc", 10, false, "dts")]);
    expect(facts).toEqual({ files: 3, hdr: 1, kinds: { hevc10: 2, h264: 1 }, audioConverted: 2 });
    expect(ids(inputs({ library: facts }))).toEqual(["audio_converted"]);
  });

  test("puts problems before slower stages before notes", () => {
    const items = PlaybackDiagnostics.evaluate(inputs({ report: { ...rockchipReport, toneMaps: false } }, { memoryBytes: 1024 ** 3, transcodesFreeBytes: 1024 ** 3 }));
    expect(items.map((item) => item.level)).toEqual(["problem", "slower", "note"]);
  });
});
