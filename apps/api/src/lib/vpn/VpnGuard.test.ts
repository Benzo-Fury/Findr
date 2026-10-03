/**
 * Tests of the VPN killswitch's checks against faked interfaces, routes and
 * public address lookup: what counts as up, that it fails closed, the
 * addresses sockets are bound to, and that listeners hear about changes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import type { VpnStatus } from "@findr/types/vpn";
import { database } from "../db/client";
import { isIPv6 } from "node:net";
import { SettingsStore } from "../db/models/SettingsStore";
import { SuspendedError } from "../pipeline/errors";
import VpnGuard, { type VpnProbes } from "./VpnGuard";

// ---------- Fakes ---------- //

/** One interface address as `os.networkInterfaces()` reports it. */
function address(value: string, internal = false): NetworkInterfaceInfo {
  const v6 = value.includes(":");
  return v6
    ? { address: value, internal, family: "IPv6", netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", cidr: `${value}/64`, scopeid: 0 }
    : { address: value, internal, family: "IPv4", netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${value}/24` };
}

/** What the fake machine currently reports. */
let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
/** The interface each family's internet traffic is routed through. */
let routeV4: string;
let routeV6: string;
let publicIp: string | Error;
let lookups: number;

/** Probes that read the variables above, counting lookups. */
const probes: VpnProbes = {
  interfaces: () => interfaces,
  // The routed interface's first address of the destination's family, or no route
  route: async (destination) => {
    const v6 = isIPv6(destination);
    const entries = interfaces[v6 ? routeV6 : routeV4] ?? [];
    return entries.find((entry) => entry.family === (v6 ? "IPv6" : "IPv4") && !/^fe80/i.test(entry.address))?.address ?? null;
  },
  watchRoutes: () => null,
  publicIp: async () => {
    lookups++;
    if (publicIp instanceof Error) throw publicIp;
    return publicIp;
  },
};

const guard = VpnGuard.getInstance();

beforeEach(async () => {
  database.run("DELETE FROM settings");
  interfaces = { lo0: [address("127.0.0.1", true)], en0: [address("192.168.1.20"), address("2001:db8:1::20")] };
  routeV4 = "en0";
  routeV6 = "en0";
  publicIp = "203.0.113.9";
  lookups = 0;
  // Fresh probes also forget the last lookup
  guard.useProbes(probes);
  await guard.check();
});

// ---------- Tests ---------- //

describe("VpnGuard", () => {
  test("is off and allows traffic while the killswitch is disabled", async () => {
    expect((await guard.check()).state).toBe("off");
    expect(guard.allowed).toBe(true);
    expect(() => guard.assertAllowed()).not.toThrow();
  });

  test("fails closed when enabled without an interface to bind to", async () => {
    SettingsStore.update({ vpn: { enabled: true, homeIps: "198.51.100.7" } });
    expect(await guard.check()).toMatchObject({ state: "down", reason: "Set the VPN's interface so torrents can be bound to it" });
    expect(guard.allowed).toBe(false);
    expect(() => guard.assertAllowed()).toThrow(SuspendedError);
  });

  test("needs the interface up with an address that is not link-local", async () => {
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0" } });
    routeV4 = routeV6 = "wg0";
    expect(await guard.check()).toMatchObject({ state: "down", reason: "The VPN interface wg0 is not up" });

    interfaces.wg0 = [address("fe80::1")];
    expect((await guard.check()).state).toBe("down");

    interfaces.wg0 = [address("fe80::1"), address("10.2.0.2")];
    expect(await guard.check()).toMatchObject({ state: "up", interfaceName: "wg0", addresses: ["10.2.0.2"] });
    expect(guard.allowed).toBe(true);
  });

  test("matches a prefix, skipping idle tunnels", async () => {
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "utun*" } });
    routeV4 = routeV6 = "utun5";
    interfaces.utun0 = [address("fe80::a")];
    interfaces.utun1 = [address("fe80::b")];
    expect((await guard.check()).state).toBe("down");

    interfaces.utun5 = [address("10.8.0.4")];
    expect(await guard.check()).toMatchObject({ state: "up", interfaceName: "utun5" });
  });

  test("trips when IPv4 or IPv6 internet traffic would bypass the tunnel", async () => {
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0" } });
    interfaces.wg0 = [address("10.2.0.2")];
    expect(await guard.check()).toMatchObject({ state: "down", reason: "IPv4 traffic would leave through en0, not the VPN" });

    // An IPv4-only tunnel with IPv6 still going out the home connection
    routeV4 = "wg0";
    expect(await guard.check()).toMatchObject({ state: "down", reason: "IPv6 traffic would leave through en0, not the VPN" });

    // No IPv6 route at all leaks nothing
    routeV6 = "none";
    expect((await guard.check()).state).toBe("up");
  });

  test("binds sockets to the tunnel's address of each family", async () => {
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0" } });
    interfaces.wg0 = [address("10.2.0.2"), address("fd00::2")];
    routeV4 = routeV6 = "wg0";
    await guard.check();
    expect(guard.binding()).toEqual({ ipv4: "10.2.0.2", ipv6: "fd00::2" });

    // The address goes the moment the tunnel does, without waiting for a check
    delete interfaces.wg0;
    expect(() => guard.binding()).toThrow("The VPN interface wg0 is not up");
  });

  test("trips when traffic leaves from a home address, or the lookup fails", async () => {
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0", homeIps: "198.51.100.7, 2001:DB8::1" } });
    interfaces.wg0 = [address("10.2.0.2")];
    routeV4 = "wg0";
    routeV6 = "none";

    expect(await guard.check()).toMatchObject({ state: "up", publicIp: "203.0.113.9" });

    publicIp = "198.51.100.7";
    expect(await guard.check({ lookupIp: true })).toMatchObject({ state: "down", publicIp: "198.51.100.7" });

    publicIp = "2001:db8::1";
    expect((await guard.check({ lookupIp: true })).state).toBe("down");

    publicIp = new Error("offline");
    expect(await guard.check({ lookupIp: true })).toMatchObject({ state: "down", reason: "Could not look up the public IP: offline" });
  });

  test("reuses a recent lookup while the VPN stays up, but re-checks one that has just come back", async () => {
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0", homeIps: "198.51.100.7" } });
    interfaces.wg0 = [address("10.2.0.2")];
    routeV4 = "wg0";
    routeV6 = "none";
    await guard.check();
    await guard.check();
    expect(lookups).toBe(1);

    // The tunnel drops: no lookup is needed to know it is down
    delete interfaces.wg0;
    expect((await guard.check()).state).toBe("down");
    expect(lookups).toBe(1);

    // It comes back: the address must be proven again
    interfaces.wg0 = [address("10.2.0.2")];
    expect((await guard.check()).state).toBe("up");
    expect(lookups).toBe(2);
  });

  test("tells listeners when the state or the addresses change", async () => {
    const heard: string[] = [];
    const unsubscribe = guard.subscribe((status) => heard.push(`${status.state} ${status.addresses.join(",")}`));
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0" } });
    interfaces.wg0 = [address("10.2.0.2")];
    routeV4 = "wg0";
    routeV6 = "none";

    await guard.check();
    await guard.check();
    interfaces.wg0 = [address("10.2.0.3")];
    await guard.check();
    delete interfaces.wg0;
    expect(() => guard.assertAllowed()).toThrow("The VPN interface wg0 is not up");
    unsubscribe();

    expect(heard).toEqual(["up 10.2.0.2", "up 10.2.0.3", "down "]);
  });

  test("re-checks the moment the routes change", async () => {
    let notify = () => undefined as void;
    let stopped = false;
    guard.useProbes({ ...probes, watchRoutes: (onChange) => ((notify = onChange), { stop: () => (stopped = true), exited: new Promise(() => undefined) }) });
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0" } });
    interfaces.wg0 = [address("10.2.0.2")];
    routeV4 = "wg0";
    routeV6 = "none";
    expect((await guard.check()).state).toBe("up");

    // The default route reverts to the home connection
    routeV4 = "en0";
    notify();
    await Bun.sleep(10);
    expect(guard.status).toMatchObject({ state: "down", reason: "IPv4 traffic would leave through en0, not the VPN" });

    // Turning the killswitch off ends the watch
    SettingsStore.update({ vpn: { enabled: false } });
    await guard.check();
    expect(stopped).toBe(true);
  });
});
