/**
 * Tests of the torrent engine's transport against the real `net` and
 * `dgram` modules, without reaching the internet: bound sockets are only
 * bound or listened on, and refused ones fail before anything is opened.
 */

import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import { TransportUnavailableError } from "tinytorrent";
import { SuspendedError } from "../pipeline/errors";
import type VpnGuard from "./VpnGuard";
import type { VpnBinding } from "./VpnGuard";
import { VpnTransport } from "./VpnTransport";

/** What the fake guard answers: a binding, null for "killswitch off", or an error for "blocked". */
let answer: VpnBinding | null | Error = null;
const guard = {
  binding: () => {
    if (answer instanceof Error) throw answer;
    return answer;
  },
} as unknown as VpnGuard;
const transport = new VpnTransport(guard);

/** Waits for a socket to connect, or for the error it fails with. */
function outcome(socket: Socket): Promise<Error | "connected"> {
  return new Promise((resolve) => {
    socket.once("connect", () => resolve("connected"));
    socket.once("error", resolve);
  });
}

describe("VpnTransport", () => {
  test("uses the system's routes while the killswitch is off", async () => {
    answer = null;
    expect(transport.localAddress()).toBeUndefined();

    const server = await transport.listen(0, (socket) => socket.end());
    try {
      const port = (server.address() as { port: number }).port;
      const socket = transport.connect("127.0.0.1", port);
      expect(await outcome(socket)).toBe("connected");
      socket.destroy();
    } finally {
      server.close();
    }
  });

  test("binds every kind of socket to the VPN's address of the matching family", async () => {
    answer = { ipv4: "127.0.0.1", ipv6: "::1" };
    expect(transport.localAddress()).toBe("127.0.0.1");

    // The listener and UDP sockets, IPv4 unless asked for IPv6
    const server = await transport.listen(0, (socket) => socket.end());
    const udp4 = await transport.udp(0);
    const udp6 = await transport.udp(0, 6);
    try {
      expect((server.address() as { address: string }).address).toBe("127.0.0.1");
      expect(udp4.address().address).toBe("127.0.0.1");
      expect(udp6.address().address).toBe("::1");

      // Outgoing connections leave from the VPN's address
      const port = (server.address() as { port: number }).port;
      const socket = transport.connect("127.0.0.1", port);
      expect(await outcome(socket)).toBe("connected");
      expect(socket.localAddress).toBe("127.0.0.1");
      socket.destroy();
    } finally {
      server.close();
      udp4.close();
      udp6.close();
    }
  });

  test("refuses a peer of a family the VPN has no address for", () => {
    answer = { ipv4: "127.0.0.1", ipv6: null };
    expect(() => transport.connect("2001:db8::1", 6881)).toThrow(TransportUnavailableError);
  });

  test("opens nothing while the killswitch blocks traffic", async () => {
    answer = new SuspendedError("The VPN interface wg0 is not up");
    expect(transport.localAddress()).toBeUndefined();
    expect(() => transport.connect("192.0.2.1", 6881)).toThrow("The VPN interface wg0 is not up");
    await expect(transport.listen(0, () => undefined)).rejects.toBeInstanceOf(TransportUnavailableError);
    await expect(transport.udp(0)).rejects.toBeInstanceOf(TransportUnavailableError);
    await expect(transport.httpGet("http://192.0.2.1/announce", 1_000)).rejects.toBeInstanceOf(TransportUnavailableError);
    answer = null;
  });
});
