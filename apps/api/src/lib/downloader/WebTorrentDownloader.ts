/**
 * `Downloader` backed by an in-process WebTorrent client, so Findr needs no
 * external torrent client. One client is shared by every attempt; it is
 * created on the first add, so a process that never downloads opens no ports.
 *
 * Torrents are added with nothing selected. Block requests are also gated
 * until `start()`: with nothing selected WebTorrent still fetches pieces a
 * peer offers through the Fast extension's allowed-fast set, and gating keeps
 * the "nothing downloads before inspection" guarantee. The file list itself
 * arrives over `ut_metadata`, which the gate does not touch.
 *
 * uTP is disabled: its native module crashes Bun. Peers connect over TCP,
 * which every mainstream client supports. The DHT's known nodes are saved to
 * the database so a restart does not depend on the public bootstrap servers.
 *
 * With the VPN killswitch on, the client is only created while the VPN
 * checks pass, and every socket it opens is bound to the VPN's address (see
 * `VpnSockets`). What cannot be bound stays off: router port mapping, local
 * discovery, web seeds, HTTP trackers (they go through `fetch`) and fetching
 * metadata from a magnet's `xs` URL. `disconnect()` destroys the client the
 * moment the VPN drops.
 *
 * Handles are the attempt's unique tag. Torrents live only as long as the
 * process; after a restart there is nothing to sweep, and the queue's
 * recovery deletes the interrupted attempts' files.
 */

import WebTorrent, { type Torrent } from "webtorrent";
import { z } from "zod";
import { AppState } from "../db/models/AppState";
import { SettingsStore } from "../db/models/SettingsStore";
import { AttemptFailure, FatalDownloadError, SuspendedError } from "../pipeline/errors";
import VpnGuard from "../vpn/VpnGuard";
import type { AddOptions, Downloader, TorrentFile, TorrentInput, TorrentStatus } from "./Downloader";

// ---------- Types ---------- //

/** How the client finds peers. Tests turn discovery off and connect peers directly. */
export interface WebTorrentOptions {
  /**
   * TCP port for peers and UDP port for the DHT; 0 picks a free one. Defaults
   * to the torrent settings, read each time the client starts.
   */
  port?: number;
  /** DHT, local service discovery, trackers and router port mapping. */
  discovery: boolean;
}

/** One torrent this downloader added, with what the pipeline has asked of it. */
interface Entry {
  torrent: Torrent;
  /** Whether `start()` has run; block requests are refused until it has. */
  started: boolean;
  /** Whether `stop()` has run, after which the files are being processed. */
  stopped: boolean;
  /** Why the killswitch destroyed this torrent mid-transfer, if it did. */
  suspended: string | null;
  /** File indexes chosen by `start()`. */
  selected: number[];
  /** The torrent's error, once it has failed. */
  error: string | null;
}

/** A DHT node, as stored between restarts. */
const DhtNodesSchema = z.array(z.object({ host: z.string(), port: z.number().int() }));
type DhtNode = z.infer<typeof DhtNodesSchema>[number];

/** The parts of `bittorrent-dht` used here; WebTorrent's typings leave `client.dht` untyped. */
interface DhtTable {
  addNode(node: DhtNode): void;
  toJSON(): { nodes: DhtNode[] };
}

/** WebTorrent's internal per-torrent block request, which the gate wraps. */
type RequestBlock = (...args: unknown[]) => boolean;

// ---------- Constants ---------- //

/** `app_state` key holding the DHT's known nodes. */
const DHT_NODES_KEY = "torrent.dhtNodes";
/** How often the DHT's nodes are saved, and how many are kept. */
const DHT_SAVE_INTERVAL_MS = 10 * 60_000;
const DHT_MAX_SAVED_NODES = 300;
/** Longest `remove()` waits for a torrent to close and delete its files. */
const DESTROY_TIMEOUT_MS = 15_000;

// ---------- Downloader ---------- //

export class WebTorrentDownloader implements Downloader {
  private readonly options: WebTorrentOptions;
  private client: WebTorrent | null = null;
  /** The port the current client was started on, for error messages. */
  private port = 0;
  /** Set when the client fails as a whole (e.g. its port is taken); reported once, then the client is rebuilt. */
  private clientError: Error | null = null;
  private readonly entries = new Map<string, Entry>();
  private dhtSaveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<WebTorrentOptions> = {}) {
    this.options = { discovery: true, ...options };
  }

  public async add(input: TorrentInput, options: AddOptions): Promise<string> {
    const client = this.ensureClient();
    const vpn = SettingsStore.section("vpn").enabled;

    // Add with nothing selected; the gate stops any block request until start()
    const torrent = client.add(input.kind === "magnet" ? input.uri : Buffer.from(input.bytes), {
      path: options.directory,
      deselect: true,
      destroyStoreOnDestroy: true,
    });
    const entry: Entry = { torrent, started: false, stopped: false, suspended: null, selected: [], error: null };
    if (!WebTorrentDownloader.gateRequests(torrent, () => entry.started)) {
      console.warn("[Downloader] WebTorrent has no _request method; pieces may arrive before inspection");
    }
    // Behind the killswitch, fail closed if the HTTP paths cannot be shut
    if (vpn && !WebTorrentDownloader.restrictToBoundTransports(torrent)) {
      torrent.destroy();
      throw new FatalDownloadError("WebTorrent has changed: its HTTP trackers cannot be turned off for the VPN killswitch");
    }

    // Torrent errors (invalid metadata, a duplicate) belong to this release
    torrent.on("error", (error) => {
      entry.error = error instanceof Error ? error.message : String(error);
    });

    this.entries.set(options.tag, entry);
    return options.tag;
  }

  public async files(handle: string): Promise<TorrentFile[] | null> {
    const entry = this.entry(handle);
    if (!entry) throw new AttemptFailure("The torrent was removed from the download client");
    if (entry.error) throw new AttemptFailure(`The torrent could not be loaded: ${entry.error}`);

    // Not ready until the file list is known and storage is open
    if (!entry.torrent.ready) return null;
    return entry.torrent.files.map((file, index) => ({ index, path: file.path, sizeBytes: file.length }));
  }

  public async start(handle: string, fileIndexes: number[]): Promise<void> {
    const entry = this.entry(handle);
    if (!entry) throw new AttemptFailure("The torrent was removed from the download client");

    // Open the gate, then select only the wanted files
    entry.started = true;
    entry.selected = fileIndexes;
    for (const index of fileIndexes) entry.torrent.files[index]?.select();
  }

  public async status(handle: string): Promise<TorrentStatus | null> {
    const entry = this.entry(handle);
    if (!entry) return null;
    const { torrent } = entry;
    const base = { speedBytesPerSecond: torrent.downloadSpeed, peers: torrent.numPeers };

    // A failed torrent, or one still waiting for its file list
    if (entry.error) {
      return { ...base, state: "error", downloadedBytes: 0, totalBytes: 0, progress: 0, error: entry.error };
    }
    if (!torrent.ready) return { ...base, state: "metadata", downloadedBytes: 0, totalBytes: 0, progress: 0 };

    // Progress over the selected files only. A verified file counts in full:
    // WebTorrent under-reports a file that ends exactly on a piece boundary
    const selected = entry.selected.flatMap((index) => torrent.files[index] ?? []);
    const totalBytes = selected.reduce((sum, file) => sum + file.length, 0);
    const downloadedBytes = selected.reduce(
      (sum, file) => sum + (file.done ? file.length : Math.min(file.downloaded, file.length)),
      0,
    );

    // Complete only once every selected file's pieces have been verified
    const complete = entry.started && selected.every((file) => file.done || file.length === 0);
    return {
      ...base,
      state: complete ? "complete" : "downloading",
      downloadedBytes,
      totalBytes,
      progress: totalBytes > 0 ? downloadedBytes / totalBytes : 1,
    };
  }

  public async stop(handle: string): Promise<void> {
    const entry = this.entry(handle);
    if (!entry) return;

    // Refuse new peers and drop current ones, so nothing reads or writes the files
    entry.stopped = true;
    entry.torrent.pause();
    for (const wire of entry.torrent.wires) wire.destroy();
  }

  public async remove(handle: string): Promise<void> {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);

    // A torrent that already failed or was disconnected is destroyed, and
    // WebTorrent never calls back for a second destroy; the attempt's
    // workspace removes its files
    const { torrent } = entry;
    if ((torrent as unknown as { destroyed?: boolean }).destroyed) return;

    // Destroying the torrent deletes the files it wrote; never let a stuck
    // store hold up the attempt's cleanup
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, DESTROY_TIMEOUT_MS);
      torrent.destroy({ destroyStore: true }, () => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }

  public async managed(): Promise<Map<string, string>> {
    return new Map([...this.entries.keys()].map((tag) => [tag, tag]));
  }

  public async disconnect(reason: string): Promise<void> {
    const client = this.client;
    this.client = null;
    this.stopDhtSaving();

    // Mark transfers first, so a poll racing the teardown sees the suspension
    // rather than a vanished torrent it would blame on the release
    const destroying: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      const { torrent } = entry;
      if (!entry.stopped) entry.suspended = reason;
      if ((torrent as unknown as { destroyed?: boolean }).destroyed) continue;

      // Keep the files of a finished transfer; drop a partial one's
      destroying.push(
        new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, DESTROY_TIMEOUT_MS);
          torrent.destroy({ destroyStore: !entry.stopped }, () => {
            clearTimeout(fallback);
            resolve();
          });
        }),
      );
    }

    // Then the client itself: its listener, the DHT and tracker sockets
    if (client && !client.destroyed) {
      destroying.push(
        new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, DESTROY_TIMEOUT_MS);
          client.destroy(() => {
            clearTimeout(fallback);
            resolve();
          });
        }),
      );
    }
    await Promise.all(destroying);
  }

  // ---------- Internals ---------- //

  /**
   * The shared client, created on first use. Throws if the client has failed,
   * or `SuspendedError` while the VPN killswitch holds traffic back.
   */
  private ensureClient(): WebTorrent {
    this.throwIfClientFailed();
    const guard = VpnGuard.getInstance();
    guard.assertAllowed();
    if (this.client && !this.client.destroyed) return this.client;
    // Every socket the client opens from here on is bound to the VPN while the killswitch is on
    guard.bindSockets();

    // The port setting applies whenever a client starts, so a change needs a restart
    const port = this.options.port ?? SettingsStore.section("torrent").port;
    const { discovery } = this.options;
    // Behind the killswitch, nothing that could leave outside the VPN: no
    // router port mapping, LAN announcements or HTTP web seeds
    const vpn = SettingsStore.section("vpn").enabled;
    const local = discovery && !vpn;
    this.port = port;
    const client = new WebTorrent({
      utp: false,
      torrentPort: port,
      dhtPort: port,
      dht: discovery,
      lsd: local,
      tracker: discovery,
      natUpnp: local,
      natPmp: local,
      webSeeds: !vpn,
    });
    if (!WebTorrentDownloader.destroyOnce(client)) {
      console.warn("[Downloader] WebTorrent internals changed; a port clash may crash the process");
    }

    // Torrent errors have their own listeners, so anything here is the client's
    client.on("error", (error) => {
      this.clientError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Downloader] Torrent client failed: ${this.clientError.message}`);
    });

    this.client = client;
    if (discovery) this.restoreDhtNodes(client);
    return client;
  }

  /** Looks up a torrent, first surfacing any client-wide failure or a killswitch suspension. */
  private entry(handle: string): Entry | undefined {
    this.throwIfClientFailed();
    const entry = this.entries.get(handle);
    if (entry?.suspended) throw new SuspendedError(entry.suspended);
    return entry;
  }

  /**
   * A failed client (most often a port already in use) takes every torrent
   * with it. Report it as an environment problem so no release is blamed,
   * and tear the client down so the next attempt starts a fresh one.
   */
  private throwIfClientFailed(): void {
    if (!this.clientError) return;
    const cause = this.clientError;

    this.clientError = null;
    this.entries.clear();
    this.stopDhtSaving();
    // WebTorrent destroys a client that cannot listen, and throws on a second destroy
    if (this.client && !this.client.destroyed) this.client.destroy();
    this.client = null;

    throw new FatalDownloadError(WebTorrentDownloader.clientFailureMessage(cause, this.port), { cause });
  }

  /** Explains a client failure in terms a user can act on, rather than the socket error. */
  public static clientFailureMessage(error: Error, port: number): string {
    const code = (error as NodeJS.ErrnoException).code ?? error.message.match(/\bE[A-Z]+\b/)?.[0];
    if (code === "EADDRINUSE") {
      return `The torrent client couldn't start because port ${port} is already in use by another program. Close that program, or choose a different torrent port in Settings.`;
    }
    if (code === "EACCES") {
      return `The torrent client isn't allowed to use port ${port}. Choose a torrent port above 1024 in Settings.`;
    }
    return "The torrent client stopped unexpectedly. Retry the download; if it keeps failing, check the server log.";
  }

  /**
   * Makes the client's internal teardown run only once. When its port is
   * taken, the TCP listener and the DHT socket each fail and each tear the
   * client down; the second teardown destroys the NAT mapper again, which
   * rejects with "client already destroyed" and kills the process. Returns
   * false when the method is missing — a test checks for it, in case a
   * future version renames it.
   */
  public static destroyOnce(client: WebTorrent): boolean {
    const internals = client as unknown as { _destroy?: (...args: unknown[]) => void };
    const destroy = internals._destroy;
    if (typeof destroy !== "function") return false;

    internals._destroy = (...args) => {
      if (!client.destroyed) destroy.apply(client, args);
    };
    return true;
  }

  /**
   * Makes a torrent refuse block requests while `isOpen()` is false.
   * WebTorrent has no public switch for this, so its per-torrent request
   * method is wrapped. Returns false when the method is missing — a test
   * checks for it, in case a future version renames it.
   */
  public static gateRequests(torrent: Torrent, isOpen: () => boolean): boolean {
    const internals = torrent as unknown as { _request?: RequestBlock };
    const request = internals._request;
    if (typeof request !== "function") return false;

    internals._request = (...args) => isOpen() && request.apply(torrent, args);
    return true;
  }

  /**
   * Keeps a torrent to the transports the killswitch can bind: drops HTTP
   * trackers from its announce list as discovery starts (after the metadata
   * may have added more), and never fetches metadata from an `xs` URL.
   * Returns false when WebTorrent no longer has these methods — a test checks
   * for them, in case a future version renames them.
   */
  public static restrictToBoundTransports(torrent: Torrent): boolean {
    const internals = torrent as unknown as { _startDiscovery?: () => void; _getMetadataFromServer?: () => void; announce?: string[] };
    const startDiscovery = internals._startDiscovery;
    if (typeof startDiscovery !== "function" || typeof internals._getMetadataFromServer !== "function") return false;

    internals._getMetadataFromServer = () => undefined;
    internals._startDiscovery = () => {
      internals.announce = (internals.announce ?? []).filter((url) => url.startsWith("udp:"));
      startDiscovery.call(torrent);
    };
    return true;
  }

  /** Stops the periodic DHT save, for a client being torn down. */
  private stopDhtSaving(): void {
    if (this.dhtSaveTimer) clearInterval(this.dhtSaveTimer);
    this.dhtSaveTimer = null;
  }

  /** Seeds the DHT with the nodes saved last run, then keeps saving them. */
  private restoreDhtNodes(client: WebTorrent): void {
    const dht = client.dht as DhtTable | undefined;
    if (!dht) return;

    // Saved nodes are only a head start; the default bootstrap servers still apply
    const saved = DhtNodesSchema.safeParse(AppState.get(DHT_NODES_KEY));
    if (saved.success) for (const node of saved.data) dht.addNode(node);

    // Save periodically without keeping the process alive
    this.dhtSaveTimer = setInterval(() => {
      const nodes = dht.toJSON().nodes.slice(0, DHT_MAX_SAVED_NODES);
      if (nodes.length > 0) AppState.set(DHT_NODES_KEY, nodes);
    }, DHT_SAVE_INTERVAL_MS);
    this.dhtSaveTimer.unref();
  }
}
