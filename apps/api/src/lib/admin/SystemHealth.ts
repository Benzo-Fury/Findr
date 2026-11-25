/**
 * Checks everything Findr depends on, live, for the Admin page's System
 * section: Prowlarr (asked, and timed), TMDB, the VPN killswitch, the
 * download queue, ffmpeg, hardware video and cast bridges, then the server
 * itself. Each check stands alone, so one that fails or hangs is shown as down
 * without taking the others with it.
 */

import type { AdminHealth, ServiceHealth, ServiceState } from "@findr/types/admin";
import type { DiagnosticLevel } from "@findr/types/playback";
import { Analytics } from "../db/models/Analytics";
import { CastBridge } from "../db/models/CastBridge";
import { SettingsStore } from "../db/models/SettingsStore";
import { FfmpegLocator } from "../media/FfmpegLocator";
import BridgeHub from "../playback/bridge/BridgeHub";
import { PlaybackDiagnostics } from "../playback/PlaybackDiagnostics";
import Prowlarr from "../prowlarr/Prowlarr";
import Updater from "../updates/Updater";
import VpnGuard from "../vpn/VpnGuard";

// ---------- Constants ---------- //

/** When the process started, so uptime survives nothing but a restart. */
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/** Longest any one check may take before it counts as down. */
const CHECK_TIMEOUT_MS = 8_000;

/**
 * How a diagnostic level reads as a service state. Playback still works with
 * any of them, more slowly or with less fidelity; ffmpeg missing outright is
 * the ffmpeg tile's to report.
 */
const LEVEL_STATE: Record<DiagnosticLevel, ServiceState> = { problem: "warn", slower: "warn", note: "ok" };

/** Hardware APIs as people know them. */
const API_NAMES: Record<string, string> = {
  vaapi: "VA-API",
  qsv: "Quick Sync",
  nvenc: "NVENC",
  videotoolbox: "VideoToolbox",
  rkmpp: "Rockchip",
  v4l2m2m: "V4L2",
  none: "CPU",
};

// ---------- Helpers ---------- //

/** One service's health. */
function service(key: string, name: string, state: ServiceState, value: string, detail: string): ServiceHealth {
  return { key, name, state, value, detail };
}

/** Runs a check, turning an error or a hang into a down service. */
async function guarded(key: string, name: string, check: () => Promise<ServiceHealth> | ServiceHealth): Promise<ServiceHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ServiceHealth>((resolve) => {
    timer = setTimeout(() => resolve(service(key, name, "bad", "No answer", "The check didn't finish in time.")), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(check), timeout]);
  } catch (error) {
    return service(key, name, "bad", "Error", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Checks ---------- //

export class SystemHealth {
  /** Every check, run side by side. */
  public async check(): Promise<AdminHealth> {
    const services = await Promise.all([
      guarded("prowlarr", "Prowlarr", () => this.prowlarr()),
      guarded("tmdb", "TMDB", () => this.tmdb()),
      guarded("vpn", "VPN killswitch", () => this.vpn()),
      guarded("queue", "Download queue", () => this.queue()),
      guarded("ffmpeg", "ffmpeg", () => this.ffmpeg()),
      guarded("hardware", "Hardware video", () => this.hardware()),
      guarded("bridges", "Cast bridges", () => this.bridges()),
    ]);

    const updates = Updater.getInstance().status;
    return {
      services,
      server: {
        version: updates.current,
        update: updates.available ? (updates.latest?.version ?? null) : null,
        startedAt: STARTED_AT,
        platform: process.env.FINDR_TARGET ?? `${process.platform}-${process.arch}`,
      },
    };
  }

  /** Whether Prowlarr answers, and how quickly. */
  private async prowlarr(): Promise<ServiceHealth> {
    const { prowlarrUrl, prowlarrApiKey } = SettingsStore.section("services");
    if (!prowlarrUrl || !prowlarrApiKey) return service("prowlarr", "Prowlarr", "bad", "Not set up", "Add its address and API key in Settings.");
    const started = performance.now();
    const reachable = await Prowlarr.getInstance().reachable();
    const ms = Math.round(performance.now() - started);
    return reachable
      ? service("prowlarr", "Prowlarr", ms > 2000 ? "warn" : "ok", `${ms} ms`, "Answering searches")
      : service("prowlarr", "Prowlarr", "bad", "Unreachable", `No answer from ${prowlarrUrl}`);
  }

  /** Whether TMDB can be asked at all. */
  private tmdb(): ServiceHealth {
    return SettingsStore.section("services").tmdbApiKey
      ? service("tmdb", "TMDB", "ok", "Key set", "Titles, posters and episode lists")
      : service("tmdb", "TMDB", "bad", "No key", "Add a TMDB API key in Settings.");
  }

  /** The killswitch's latest verdict. */
  private vpn(): ServiceHealth {
    const status = VpnGuard.getInstance().status;
    if (status.state === "off") return service("vpn", "VPN killswitch", "off", "Off", "Torrents use the normal connection.");
    if (status.state === "down") return service("vpn", "VPN killswitch", "bad", "Blocking", status.reason ?? "The VPN is down, so torrents are paused.");
    return service("vpn", "VPN killswitch", "ok", status.interfaceName ?? "Up", status.publicIp ? `Torrents leave as ${status.publicIp}` : "Torrents go through the VPN.");
  }

  /** What the queue is doing. */
  private queue(): ServiceHealth {
    const { queued, running } = Analytics.activeDownloads();
    const detail = queued > 0 ? `${queued} waiting their turn` : running > 0 ? "Nothing waiting" : "Idle";
    return service("queue", "Download queue", "ok", `${running} running`, detail);
  }

  /** Whether ffmpeg and ffprobe were found. */
  private async ffmpeg(): Promise<ServiceHealth> {
    const tools = await FfmpegLocator.resolve();
    const missing = tools.filter((tool) => tool.path === null);
    if (missing.length > 0) return service("ffmpeg", "ffmpeg", "bad", "Missing", `${missing.map((tool) => tool.name).join(" and ")} not found, so nothing can be cleaned or played.`);
    const version = tools.find((tool) => tool.name === "ffmpeg")?.version ?? null;
    return service("ffmpeg", "ffmpeg", "ok", version ? version.split(/[-\s]/)[0] ?? version : "Found", tools[0]?.source === "embedded" ? "The copy built into Findr" : "Found on this machine");
  }

  /** What stops this machine converting video fully on the hardware, from the last hardware check. */
  private async hardware(): Promise<ServiceHealth> {
    const settings = SettingsStore.section("playback");
    if (!settings.enabled) return service("hardware", "Hardware video", "off", "Off", "Playback is turned off.");
    const { hardware, items } = await PlaybackDiagnostics.run(settings);
    const worst = items[0];
    const value = hardware ? (hardware.encodes ? (API_NAMES[hardware.api] ?? hardware.api) : "CPU only") : "Unchecked";
    return worst
      ? service("hardware", "Hardware video", LEVEL_STATE[worst.level], value, worst.title)
      : service("hardware", "Hardware video", "ok", value, "Converts fully on the hardware");
  }

  /** How many cast bridges are connected. */
  private bridges(): ServiceHealth {
    const bridges = CastBridge.all();
    if (bridges.length === 0) return service("bridges", "Cast bridges", "off", "None", "No other networks are linked.");
    const hub = BridgeHub.getInstance();
    const offline = bridges.filter((bridge) => !hub.get(bridge.id)?.connected);
    const value = `${bridges.length - offline.length} of ${bridges.length}`;
    return offline.length === 0
      ? service("bridges", "Cast bridges", "ok", value, "Every bridge connected")
      : service("bridges", "Cast bridges", offline.length === bridges.length ? "bad" : "warn", value, `${offline.map((bridge) => bridge.name).join(", ")} offline`);
  }
}
