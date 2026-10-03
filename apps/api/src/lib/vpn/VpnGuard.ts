/**
 * The VPN killswitch. Decides whether torrent traffic is allowed, binds the
 * torrent client's sockets to the VPN, and tells the download queue the
 * moment either changes.
 *
 * Its defences, every one of which must hold:
 *
 *   binding    every torrent socket is bound to the VPN interface's address,
 *              resolved again for each one (see `VpnSockets`), so traffic
 *              cannot leave from any other address even between checks
 *   interface  the VPN's interface exists and holds an address that is not
 *              link-local
 *   routes     the OS would send IPv4 and IPv6 internet traffic through that
 *              interface — re-checked the moment the routing table changes,
 *              and every second besides
 *   home IP    optionally, the public address, looked up over HTTPS, is not
 *              one of the home connection's — proves where traffic exits, so
 *              it runs once a minute and whenever the VPN has just come back
 *
 * It fails closed: with the killswitch on, the VPN counts as down until a
 * check has passed, when no interface is configured, and when the public
 * address cannot be looked up.
 */

import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { VpnSettings } from "@findr/types/settings";
import type { VpnStatus } from "@findr/types/vpn";
import { SettingsStore } from "../db/models/SettingsStore";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { SuspendedError } from "../pipeline/errors";
import VpnSockets, { type VpnBinding } from "./VpnSockets";

// ---------- Types ---------- //

/** A running watch on the routing table. */
export interface RouteWatch {
  stop(): void;
  /** Settles when the watch ends on its own, so it can be restarted. */
  exited: Promise<unknown>;
}

/** Where the guard reads the machine's state. Tests replace these. */
export interface VpnProbes {
  /** The machine's network interfaces, as `os.networkInterfaces()` reports them. */
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** The source address the OS would use to reach `destination`, or null when it has no route there. */
  route(destination: string): Promise<string | null>;
  /** Calls `onChange` whenever the routing table or an address changes. Null where that cannot be watched. */
  watchRoutes(onChange: () => void): RouteWatch | null;
  /** The public address traffic currently leaves from. */
  publicIp(signal: AbortSignal): Promise<string>;
}

/** The latest public address lookup: an address, or why there is none. */
interface IpLookup {
  ip: string | null;
  error: string | null;
  at: number;
}

/** Where the OS would send traffic to one probe destination. */
interface RouteResult {
  destination: string;
  source: string | null;
}

/** Called whenever the VPN's state, the reason for it, or its addresses change. */
export type VpnListener = (status: VpnStatus, previous: VpnStatus) => void;

// ---------- Constants ---------- //

/** How often every check runs, besides whenever the routes change. */
const CHECK_INTERVAL_MS = 1_000;

/**
 * Destinations whose routes are checked: one in each half of the IPv4 space,
 * since VPNs commonly take over with `0.0.0.0/1` and `128.0.0.0/1` rather than
 * a default route, and one IPv6. Nothing is sent to them.
 */
const ROUTE_PROBES = ["1.1.1.1", "149.112.112.112", "2606:4700:4700::1111"];

/** Answers with the caller's public address, over IPv6 when the machine prefers it. */
const IP_LOOKUP_URL = "https://api64.ipify.org?format=json";
const IP_LOOKUP_TIMEOUT_MS = 5_000;
/** How long a successful lookup is trusted while the VPN stays up. */
const IP_LOOKUP_MAX_AGE_MS = 60_000;

/** The command that prints a line for every routing change, per platform. */
const ROUTE_MONITORS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["route", "-n", "monitor"],
  linux: ["ip", "monitor", "route", "address", "link"],
};

/** Reads the real machine. */
const SYSTEM_PROBES: VpnProbes = {
  interfaces: () => networkInterfaces(),

  // Connecting a UDP socket sends nothing; it only makes the OS pick a route and a source address
  route: (destination) =>
    new Promise((resolve) => {
      const socket = VpnSockets.createUnboundSocket(isIPv6(destination) ? "udp6" : "udp4");
      const finish = (source: string | null) => {
        try {
          socket.close();
        } catch {
          // Already closed by the error
        }
        resolve(source);
      };
      socket.once("error", () => finish(null));
      socket.connect(53, destination, () => finish(socket.address().address));
    }),

  watchRoutes: (onChange) => {
    const command = ROUTE_MONITORS[process.platform];
    if (!command) return null;
    try {
      const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
      void (async () => {
        for await (const chunk of child.stdout) if (chunk.length > 0) onChange();
      })().catch(() => undefined);
      return { stop: () => child.kill(), exited: child.exited };
    } catch {
      return null;
    }
  },

  publicIp: async (signal) => {
    const response = await fetch(IP_LOOKUP_URL, { signal });
    if (!response.ok) throw new Error(`the lookup service answered ${response.status}`);
    const body = (await response.json()) as { ip?: unknown };
    if (typeof body.ip !== "string" || body.ip === "") throw new Error("the lookup service sent no address");
    return body.ip;
  },
};

// ---------- Guard ---------- //

export default class VpnGuard extends SelfManagedSingleton {
  private probes: VpnProbes = SYSTEM_PROBES;
  private current: VpnStatus = { ...VpnGuard.status("off"), checkedAt: null };
  private lookup: IpLookup | null = null;
  private routes: RouteResult[] | null = null;
  private monitor: RouteWatch | null = null;
  private inFlight: Promise<VpnStatus> | null = null;
  /** Set when the routes changed during a check, so another runs after it. */
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<VpnListener>();

  /** Swaps where the machine's state is read. Used by tests. */
  public useProbes(probes: VpnProbes): this {
    this.monitor?.stop();
    this.monitor = null;
    this.probes = probes;
    this.lookup = null;
    this.routes = null;
    return this;
  }

  /** Runs a first check, then keeps checking every second and whenever the routes change. */
  public async start(): Promise<void> {
    await this.check();
    this.schedule();
  }

  /** Stops the periodic checks and the route watch. */
  public stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.monitor?.stop();
    this.monitor = null;
  }

  /** Registers a listener for state changes. Returns a function that removes it. */
  public subscribe(listener: VpnListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The latest check's outcome. */
  public get status(): VpnStatus {
    return this.current;
  }

  /** Whether torrent traffic is allowed right now: the killswitch is off, or the last check passed. */
  public get allowed(): boolean {
    return !SettingsStore.section("vpn").enabled || this.current.state === "up";
  }

  /** Throws `SuspendedError` unless torrent traffic is allowed, checking the interface again on the spot. */
  public assertAllowed(): void {
    this.binding();
  }

  /**
   * The addresses torrent sockets must be bound to: null while the killswitch
   * is off, or throws `SuspendedError` while it blocks traffic. Re-reads the
   * interfaces each time, against the latest routes and address lookup, so it
   * is cheap enough to run for every socket.
   */
  public binding(): VpnBinding | null {
    const settings = SettingsStore.section("vpn");
    if (!settings.enabled) return null;

    const status = this.evaluate(settings);
    this.record(status);
    if (status.state !== "up") throw new SuspendedError(status.reason ?? "The VPN is down");
    return { ipv4: status.addresses.find((address) => isIPv4(address)) ?? null, ipv6: status.addresses.find((address) => isIPv6(address)) ?? null };
  }

  /** Binds the process's torrent sockets to `binding()` from now on. Safe to call repeatedly. */
  public bindSockets(): void {
    VpnSockets.install(() => this.binding());
  }

  /**
   * Runs every configured check now and records the outcome. `lookupIp`
   * forces a fresh public address lookup. Concurrent calls share one check.
   */
  public check(options: { lookupIp?: boolean } = {}): Promise<VpnStatus> {
    this.inFlight ??= this.runCheck(options.lookupIp ?? false).finally(() => {
      this.inFlight = null;
      if (this.again) this.recheck();
    });
    return this.inFlight;
  }

  // ---------- Checks ---------- //

  /** Refreshes the routes and, when due, the public address, then evaluates every check. */
  private async runCheck(forceLookup: boolean): Promise<VpnStatus> {
    const settings = SettingsStore.section("vpn");
    this.watch(settings.enabled);

    if (settings.enabled) {
      this.routes = await Promise.all(ROUTE_PROBES.map(async (destination) => ({ destination, source: await this.probes.route(destination) })));

      // Look the address up when forced, when the last one is stale or failed,
      // or when the VPN was not up — a tunnel that just came back must prove itself
      if (VpnGuard.homeIps(settings).length > 0) {
        const stale = !this.lookup || this.lookup.error !== null || Date.now() - this.lookup.at > IP_LOOKUP_MAX_AGE_MS;
        const tunnelPresent = this.findInterface(settings.interfaceName) !== null;
        if (forceLookup || stale || (this.current.state !== "up" && tunnelPresent)) await this.lookUpIp();
      }
    }

    const status = this.evaluate(settings);
    this.record(status);
    return status;
  }

  /** Decides the VPN's state from the interfaces now and the latest routes and address lookup. */
  private evaluate(settings: VpnSettings): VpnStatus {
    if (!settings.enabled) return VpnGuard.status("off");
    const name = settings.interfaceName;
    if (name === "") return VpnGuard.status("down", { reason: "Set the VPN's interface so torrents can be bound to it" });

    // The tunnel's interface must be up with a usable address
    const found = this.findInterface(name);
    if (!found) {
      const reason = name.endsWith("*") ? `No VPN interface matching ${name} is up` : `The VPN interface ${name} is not up`;
      return VpnGuard.status("down", { reason });
    }
    const matched = { interfaceName: found.name, addresses: found.addresses };

    // Internet traffic must be routed through it; a family with no route at all leaks nothing
    if (!this.routes) return VpnGuard.status("down", { ...matched, reason: "The routes have not been checked yet" });
    for (const { destination, source } of this.routes) {
      if (source === null) continue;
      const via = this.interfaceOf(source);
      if (via !== found.name) {
        const family = isIPv6(destination) ? "IPv6" : "IPv4";
        return VpnGuard.status("down", { ...matched, reason: `${family} traffic would leave through ${via ?? source}, not the VPN` });
      }
    }

    // Traffic must not be leaving from the home connection
    const homeIps = VpnGuard.homeIps(settings);
    if (homeIps.length > 0) {
      if (!this.lookup) return VpnGuard.status("down", { ...matched, reason: "The public IP has not been checked yet" });
      if (this.lookup.error !== null || this.lookup.ip === null) {
        return VpnGuard.status("down", { ...matched, reason: `Could not look up the public IP: ${this.lookup.error ?? "no address"}` });
      }
      const publicIp = this.lookup.ip;
      if (homeIps.includes(publicIp.toLowerCase())) {
        return VpnGuard.status("down", { ...matched, publicIp, reason: `Traffic is leaving from ${publicIp}, your home IP` });
      }
      return VpnGuard.status("up", { ...matched, publicIp });
    }

    return VpnGuard.status("up", matched);
  }

  /** Looks up the public address and keeps the result, success or not. */
  private async lookUpIp(): Promise<void> {
    try {
      const ip = await this.probes.publicIp(AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS));
      this.lookup = { ip: ip.trim(), error: null, at: Date.now() };
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError" ? "timed out" : VpnGuard.message(error);
      this.lookup = { ip: null, error: message, at: Date.now() };
    }
  }

  /**
   * The first interface matching the name — or prefix, with a trailing `*` —
   * that holds an address other than loopback and link-local. Link-local
   * addresses are skipped because idle tunnels (macOS keeps several `utun`
   * interfaces for its own services) carry nothing else.
   */
  private findInterface(pattern: string): { name: string; addresses: string[] } | null {
    if (pattern === "") return null;
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : null;

    for (const [name, entries] of Object.entries(this.probes.interfaces())) {
      if (prefix === null ? name !== pattern : !name.startsWith(prefix)) continue;
      const addresses = (entries ?? [])
        .filter((entry) => !entry.internal && !VpnGuard.isLinkLocal(entry.address))
        .map((entry) => entry.address);
      if (addresses.length > 0) return { name, addresses };
    }
    return null;
  }

  /** The interface holding an address, if any does. */
  private interfaceOf(address: string): string | null {
    const wanted = address.toLowerCase();
    for (const [name, entries] of Object.entries(this.probes.interfaces())) {
      if (entries?.some((entry) => entry.address.toLowerCase() === wanted)) return name;
    }
    return null;
  }

  // ---------- State ---------- //

  /** Stores a new outcome, telling listeners when the state, its reason or the addresses changed. */
  private record(status: VpnStatus): void {
    const previous = this.current;
    this.current = status;
    const moved = previous.addresses.join(",") !== status.addresses.join(",");
    if (previous.state === status.state && previous.reason === status.reason && !moved) return;

    if (status.state === "down") console.warn(`[VPN] Killswitch engaged: ${status.reason}`);
    else if (previous.state === "down") console.log(`[VPN] ${status.state === "up" ? "VPN is up" : "Killswitch off"}; torrents may run`);
    for (const listener of this.listeners) listener(status, previous);
  }

  /** Watches the routing table while the killswitch is on, restarting the watch if it ends. */
  private watch(enabled: boolean): void {
    if (!enabled) {
      this.monitor?.stop();
      this.monitor = null;
      return;
    }
    if (this.monitor) return;

    const monitor = this.probes.watchRoutes(() => this.recheck());
    if (!monitor) return;
    this.monitor = monitor;
    void monitor.exited.then(() => {
      if (this.monitor === monitor) this.monitor = null;
    });
  }

  /** Checks again now, or straight after the check in progress, which may predate the change. */
  private recheck(): void {
    this.again = this.inFlight !== null;
    if (this.again) return;
    this.check().catch((error: unknown) => console.error("[VPN] Check failed:", error));
  }

  /** Checks again after the interval. */
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.check()
        .catch((error: unknown) => console.error("[VPN] Check failed:", error))
        .finally(() => this.schedule());
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  // ---------- Helpers ---------- //

  /** A status with every optional detail blank unless given. */
  private static status(state: VpnStatus["state"], details: Partial<Omit<VpnStatus, "state" | "checkedAt">> = {}): VpnStatus {
    return { state, reason: null, interfaceName: null, addresses: [], publicIp: null, ...details, checkedAt: Date.now() };
  }

  /** The configured home addresses, lowercased so IPv6 compares reliably. */
  private static homeIps(settings: VpnSettings): string[] {
    return settings.homeIps
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
  }

  /** IPv4 169.254.0.0/16 and IPv6 fe80::/10. */
  private static isLinkLocal(address: string): boolean {
    return address.startsWith("169.254.") || /^fe[89ab]/i.test(address);
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
