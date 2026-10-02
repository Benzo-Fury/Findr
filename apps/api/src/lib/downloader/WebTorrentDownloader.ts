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
 * Handles are the attempt's unique tag. Torrents live only as long as the
 * process; after a restart there is nothing to sweep, and the queue's
 * recovery deletes the interrupted attempts' files.
 */

import WebTorrent, { type Torrent } from "webtorrent";
import { z } from "zod";
import { AppState } from "../db/models/AppState";
import { SettingsStore } from "../db/models/SettingsStore";
import { AttemptFailure, FatalDownloadError } from "../pipeline/errors";
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
  private clientError: string | null = null;
  private readonly entries = new Map<string, Entry>();
  private dhtSaveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<WebTorrentOptions> = {}) {
    this.options = { discovery: true, ...options };
  }

  public async add(input: TorrentInput, options: AddOptions): Promise<string> {
    const client = this.ensureClient();

    // Add with nothing selected; the gate stops any block request until start()
    const torrent = client.add(input.kind === "magnet" ? input.uri : Buffer.from(input.bytes), {
      path: options.directory,
      deselect: true,
      destroyStoreOnDestroy: true,
    });
    const entry: Entry = { torrent, started: false, selected: [], error: null };
    if (!WebTorrentDownloader.gateRequests(torrent, () => entry.started)) {
      console.warn("[Downloader] WebTorrent has no _request method; pieces may arrive before inspection");
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
    entry.torrent.pause();
    for (const wire of entry.torrent.wires) wire.destroy();
  }

  public async remove(handle: string): Promise<void> {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);

    // A torrent that already failed is destroyed, and WebTorrent never calls
    // back for a second destroy; the attempt's workspace removes its files
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

  // ---------- Internals ---------- //

  /** The shared client, created on first use. Throws if the client has failed. */
  private ensureClient(): WebTorrent {
    this.throwIfClientFailed();
    if (this.client && !this.client.destroyed) return this.client;

    // The port setting applies whenever a client starts, so a change needs a restart
    const port = this.options.port ?? SettingsStore.section("torrent").port;
    const { discovery } = this.options;
    this.port = port;
    const client = new WebTorrent({
      utp: false,
      torrentPort: port,
      dhtPort: port,
      dht: discovery,
      lsd: discovery,
      tracker: discovery,
      natUpnp: discovery,
      natPmp: discovery,
    });

    // Torrent errors have their own listeners, so anything here is the client's
    client.on("error", (error) => {
      this.clientError = error instanceof Error ? error.message : String(error);
      console.error(`[Downloader] Torrent client failed: ${this.clientError}`);
    });

    this.client = client;
    if (discovery) this.restoreDhtNodes(client);
    return client;
  }

  /** Looks up a torrent, first surfacing any client-wide failure. */
  private entry(handle: string): Entry | undefined {
    this.throwIfClientFailed();
    return this.entries.get(handle);
  }

  /**
   * A failed client (most often a port already in use) takes every torrent
   * with it. Report it as an environment problem so no release is blamed,
   * and tear the client down so the next attempt starts a fresh one.
   */
  private throwIfClientFailed(): void {
    if (!this.clientError) return;
    const message = this.clientError;

    this.clientError = null;
    this.entries.clear();
    if (this.dhtSaveTimer) clearInterval(this.dhtSaveTimer);
    this.dhtSaveTimer = null;
    // WebTorrent destroys a client that cannot listen, and throws on a second destroy
    if (this.client && !this.client.destroyed) this.client.destroy();
    this.client = null;

    throw new FatalDownloadError(`The torrent client is unavailable (port ${this.port}): ${message}`);
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
