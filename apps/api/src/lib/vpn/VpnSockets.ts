/**
 * Pins the process's sockets to the VPN interface's address while the
 * killswitch is on. WebTorrent has no option to bind its connections, but it
 * opens every one through `net` and `dgram`, so their constructors are
 * wrapped in place:
 *
 *   net.connect          outgoing peer connections get `localAddress`
 *   net.createServer     the incoming peer listener listens on the VPN address
 *   dgram.createSocket   DHT and UDP tracker sockets bind to the VPN address,
 *                        including the implicit bind of a first `send`
 *
 * The address is resolved again for every socket, so a connection can only
 * be opened from an address the VPN interface holds at that moment. When the
 * tunnel drops its address disappears, and sockets already bound to it can
 * no longer send. When the killswitch blocks traffic, a TCP connection fails
 * at once and a UDP socket is left unbound, so whatever it queues is never
 * sent.
 *
 * Loopback destinations and IPC paths pass through untouched, as does
 * everything while the killswitch is off. Nothing else in Findr uses these
 * modules: its HTTP requests go through `fetch`, which this cannot bind.
 */

import dgram from "node:dgram";
import net from "node:net";

// ---------- Types ---------- //

/** The addresses sockets are bound to, one per family the VPN carries. */
export interface VpnBinding {
  ipv4: string | null;
  ipv6: string | null;
}

/**
 * Answers which addresses to bind to: null while the killswitch is off, or
 * throws while it is blocking traffic.
 */
export type BindingResolver = () => VpnBinding | null;

type Variadic<T> = (...args: unknown[]) => T;

// ---------- Constants ---------- //

/** The unwrapped constructors, captured before anything replaces them. */
const ORIGINAL = {
  connect: net.connect as Variadic<net.Socket>,
  createServer: net.createServer as Variadic<net.Server>,
  createSocket: dgram.createSocket as Variadic<dgram.Socket>,
};

// ---------- Binder ---------- //

export default class VpnSockets {
  /**
   * The unwrapped `dgram.createSocket`, for the killswitch's own route
   * checks, which must see the route the OS would choose on its own.
   */
  public static readonly createUnboundSocket = ORIGINAL.createSocket;

  private static resolve: BindingResolver | null = null;

  /**
   * Wraps the socket constructors, once, and sets where the binding comes
   * from. Returns the previous resolver, so tests can put it back.
   */
  public static install(resolve: BindingResolver): BindingResolver | null {
    const previous = this.resolve;
    this.resolve = resolve;
    if (previous) return previous;

    // `net.createConnection` is the same function under another name
    const connect: Variadic<net.Socket> = (...args) => this.connect(args);
    const modules = { net: net as unknown as Record<string, unknown>, dgram: dgram as unknown as Record<string, unknown> };
    modules.net.connect = connect;
    modules.net.createConnection = connect;
    modules.net.createServer = (...args: unknown[]) => this.createServer(args);
    modules.dgram.createSocket = (...args: unknown[]) => this.createSocket(args);
    return null;
  }

  // ---------- TCP ---------- //

  /** `net.connect`, from the VPN address of the destination's family. */
  private static connect(args: unknown[]): net.Socket {
    // Normalise `(options, callback)` and `(port, host, callback)`; IPC paths pass through
    const [first, ...rest] = args;
    let options: net.TcpNetConnectOpts;
    if (typeof first === "object" && first !== null) {
      if (typeof (first as { path?: unknown }).path === "string") return ORIGINAL.connect(...args);
      options = { ...(first as net.TcpNetConnectOpts) };
    } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
      options = { port: Number(first), host: typeof rest[0] === "string" ? (rest.shift() as string) : undefined };
    } else {
      return ORIGINAL.connect(...args);
    }
    const host = options.host ?? "localhost";
    if (VpnSockets.isLoopback(host)) return ORIGINAL.connect(...args);

    let binding: VpnBinding | null;
    try {
      binding = this.binding();
    } catch (error) {
      return VpnSockets.refused(error);
    }
    if (!binding) return ORIGINAL.connect(...args);

    // A hostname resolves to IPv4, matching the address it is bound to
    const v6 = net.isIPv6(host);
    const localAddress = v6 ? binding.ipv6 : binding.ipv4;
    if (!localAddress) return VpnSockets.refused(new Error(`The VPN has no IPv${v6 ? 6 : 4} address to connect from`));
    return ORIGINAL.connect({ ...options, localAddress, family: v6 ? 6 : 4 }, ...rest);
  }

  /** `net.createServer`, whose `listen(port)` listens on the VPN address only. */
  private static createServer(args: unknown[]): net.Server {
    const server = ORIGINAL.createServer(...args);
    const listen = server.listen.bind(server) as Variadic<net.Server>;

    // Only a bare port is rebound; a caller that names a host chose it
    server.listen = ((...listenArgs: unknown[]) => {
      if (typeof listenArgs[0] !== "number" || typeof listenArgs[1] === "string") return listen(...listenArgs);
      const binding = this.binding();
      if (!binding) return listen(...listenArgs);

      const address = binding.ipv4 ?? binding.ipv6;
      if (!address) throw new Error("The VPN has no address to listen on");
      return listen(listenArgs[0], address, ...listenArgs.slice(1));
    }) as typeof server.listen;
    return server;
  }

  // ---------- UDP ---------- //

  /** `dgram.createSocket`, whose every bind, explicit or implicit, uses the VPN address. */
  private static createSocket(args: unknown[]): dgram.Socket {
    const socket = ORIGINAL.createSocket(...args);
    const bind = socket.bind.bind(socket) as Variadic<dgram.Socket>;
    const type = typeof args[0] === "string" ? args[0] : (args[0] as dgram.SocketOptions | undefined)?.type;

    socket.bind = ((...bindArgs: unknown[]) => {
      // Blocked: stay unbound, so anything sent is queued and never leaves
      let binding: VpnBinding | null;
      try {
        binding = this.binding();
      } catch {
        return socket;
      }
      if (!binding) return bind(...bindArgs);
      const address = type === "udp6" ? binding.ipv6 : binding.ipv4;
      if (!address) return socket;

      // Normalise `(options, callback)` and `([port], [address], [callback])`
      const callback = bindArgs.find((arg) => typeof arg === "function");
      const [first] = bindArgs;
      const options: dgram.BindOptions =
        typeof first === "object" && first !== null
          ? { ...(first as dgram.BindOptions), address }
          : { port: typeof first === "number" ? first : 0, address };
      return callback ? bind(options, callback) : bind(options);
    }) as typeof socket.bind;
    return socket;
  }

  // ---------- Helpers ---------- //

  /** The current binding, or null while nothing has installed a resolver. */
  private static binding(): VpnBinding | null {
    return this.resolve ? this.resolve() : null;
  }

  /** A socket that fails with `error` as soon as its caller has attached listeners. */
  private static refused(error: unknown): net.Socket {
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(error instanceof Error ? error : new Error(String(error))));
    return socket;
  }

  private static isLoopback(host: string): boolean {
    return host === "localhost" || host.startsWith("127.") || host === "::1" || host.startsWith("::ffff:127.");
  }
}
