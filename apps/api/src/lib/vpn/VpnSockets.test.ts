/**
 * Tests of the socket binder against the real `net` and `dgram` modules,
 * without reaching the internet: bound sockets are only bound or listened
 * on, and refused connections fail before anything is sent.
 */

import { afterAll, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import net from "node:net";
import VpnSockets, { type BindingResolver, type VpnBinding } from "./VpnSockets";

/** What the resolver answers: a binding, null for "killswitch off", or an error for "blocked". */
let answer: VpnBinding | null | Error = null;
const previous: BindingResolver | null = VpnSockets.install(() => {
  if (answer instanceof Error) throw answer;
  return answer;
});
// Other test files share the process: put the binder back to passing everything through
afterAll(() => {
  answer = null;
  if (previous) VpnSockets.install(previous);
});

/** An address nothing answers on (TEST-NET-1), so a connection that got out would never complete. */
const NOWHERE = "192.0.2.1";

describe("VpnSockets", () => {
  test("binds UDP sockets, explicit or not, to the VPN address", async () => {
    answer = { ipv4: "127.0.0.1", ipv6: null };
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, () => resolve()));
    expect(socket.address().address).toBe("127.0.0.1");
    socket.close();
  });

  test("listens on the VPN address only", async () => {
    answer = { ipv4: "127.0.0.1", ipv6: null };
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    server.close();
  });

  test("refuses a connection while the killswitch blocks traffic", async () => {
    answer = new Error("The VPN interface wg0 is not up");
    const socket = net.connect({ host: NOWHERE, port: 9 });
    const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
    expect(error.message).toBe("The VPN interface wg0 is not up");
  });

  test("refuses a connection the VPN has no address of that family for", async () => {
    answer = { ipv4: "10.2.0.2", ipv6: null };
    const socket = net.connect({ host: "2001:db8::1", port: 9 });
    const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
    expect(error.message).toBe("The VPN has no IPv6 address to connect from");
  });

  test("leaves a blocked UDP socket unbound, so nothing it sends leaves", async () => {
    answer = new Error("blocked");
    const socket = dgram.createSocket("udp4");
    socket.send(Buffer.from("x"), 9, NOWHERE);
    await Bun.sleep(20);
    expect(() => socket.address()).toThrow();
    socket.close();
  });

  test("passes loopback and everything while the killswitch is off", async () => {
    const server = net.createServer((connection) => connection.end());
    answer = null;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as net.AddressInfo;

    answer = new Error("blocked");
    const socket = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    socket.destroy();
    server.close();
  });
});
