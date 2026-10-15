/**
 * `Downloader` backed by an in-process TinyTorrent engine, so Findr needs no
 * external torrent client. One engine is shared by every attempt; it is
 * created on the first add, so a process that never downloads opens no ports.
 *
 * Torrents are added with `start: "metadata-only"`: the engine fetches the
 * file list and then requests no block until `start()` selects files, so
 * nothing downloads before inspection. Files never selected are never
 * created. Seeding is off, so a finished torrent disconnects at once.
 *
 * Every socket the engine opens goes through `VpnTransport`, which binds it
 * to the VPN's address while the killswitch is on and refuses it while the
 * VPN is down. `disconnect()` destroys the engine the moment the VPN drops,
 * leaving every torrent's files on disk; re-added in the same directory, a
 * torrent re-checks them by hash and carries on from there.
 *
 * The peer limit and the encryption policy follow the settings on every add.
 * Behind the VPN, which already encrypts, peers are tried in plaintext first
 * to save CPU. The DHT's known nodes are saved to the database so a restart
 * does not depend on the public bootstrap routers.
 *
 * Handles are the attempt's unique tag. Torrents live only as long as the
 * process; after a restart there is nothing to sweep, and the queue's
 * recovery deletes the interrupted attempts' files.
 */

import { relative } from "node:path";
import { Engine, type Magnet, type Metainfo, parseMagnet, parseTorrent, type Torrent } from "tinytorrent";
import { z } from "zod";
import { AppState } from "../db/models/AppState";
import { SettingsStore } from "../db/models/SettingsStore";
import { AttemptFailure, SuspendedError } from "../pipeline/errors";
import VpnGuard from "../vpn/VpnGuard";
import { VpnTransport } from "../vpn/VpnTransport";
import type { AddOptions, Downloader, TorrentFile, TorrentInput, TorrentStatus } from "./Downloader";

// ---------- Types ---------- //

/** How the engine finds peers. Tests turn discovery off and connect peers directly. */
export interface TinyTorrentOptions {
  /**
   * TCP port for peers and UDP port for the DHT; 0 picks a free one. Defaults
   * to the torrent settings, read each time the engine starts.
   */
  port?: number;
  /** DHT, peer exchange and router port mapping. */
  discovery: boolean;
}

/** One torrent this downloader added, with what the pipeline has asked of it. */
interface Entry {
  torrent: Torrent;
  /** The save directory, which the file paths reported to the pipeline are relative to. */
  directory: string;
  /** Whether `start()` has run; the engine requests no block until it has. */
  started: boolean;
  /** Whether `stop()` has run, after which the files are being processed. */
  stopped: boolean;
  /** Why the killswitch destroyed this torrent mid-transfer, if it did. */
  suspended: string | null;
  /** The torrent's error, once it has failed. */
  error: string | null;
}

/** The DHT's known nodes as stored between restarts: the engine's compact form, base64-encoded. */
const DhtNodesSchema = z.object({ nodes: z.string().optional(), nodes6: z.string().optional() });

// ---------- Constants ---------- //

/** `app_state` key holding the DHT's known nodes. */
const DHT_NODES_KEY = "torrent.dhtNodes";
/** How often the DHT's nodes are saved. */
const DHT_SAVE_INTERVAL_MS = 10 * 60_000;
/** Longest a torrent or the engine is given to close. */
const CLOSE_TIMEOUT_MS = 15_000;

// ---------- Downloader ---------- //

export class TinyTorrentDownloader implements Downloader {
  private readonly options: TinyTorrentOptions;
  private engine: Engine | null = null;
  private readonly entries = new Map<string, Entry>();
  private dhtSaveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<TinyTorrentOptions> = {}) {
    this.options = { discovery: true, ...options };
  }

  public async add(input: TorrentInput, options: AddOptions): Promise<string> {
    // An unreadable torrent belongs to this release, and costs no connection to find out
    const parsed = TinyTorrentDownloader.parse(input);
    const engine = this.ensureEngine();

    // The engine hands back a torrent it already holds, which saves into another attempt's directory
    if (engine.get(parsed.infoHashHex)) throw new AttemptFailure("This release is already being downloaded by another attempt");

    // Fetch the file list only; nothing is requested until start()
    TinyTorrentDownloader.applySettings(engine);
    const torrent = engine.add(parsed, { dir: options.directory, start: "metadata-only" });
    const entry: Entry = { torrent, directory: options.directory, started: false, stopped: false, suspended: null, error: null };

    // A torrent error (most often a disk write failing) belongs to this attempt
    torrent.on("error", (error: Error) => {
      entry.error = error.message;
    });
    torrent.on("warning", (message: string) => console.warn(`[Downloader] ${torrent.name}: ${message}`));

    this.entries.set(options.tag, entry);
    return options.tag;
  }

  public async files(handle: string): Promise<TorrentFile[] | null> {
    const entry = this.entry(handle);
    if (!entry) throw new AttemptFailure("The torrent was removed from the download client");
    if (entry.error) throw new AttemptFailure(`The torrent failed: ${entry.error}`);

    // Available once the file list is known; paths are reported relative to the save directory
    if (!entry.torrent.info) return null;
    return entry.torrent.files().map((file) => ({ index: file.index, path: relative(entry.directory, file.path), sizeBytes: file.length }));
  }

  public async start(handle: string, fileIndexes: number[]): Promise<void> {
    const entry = this.entry(handle);
    if (!entry) throw new AttemptFailure("The torrent was removed from the download client");

    // Data a paused attempt left on disk is checked first, which takes a while
    // for a large file; the status reports `checking` meanwhile, so do not wait
    entry.started = true;
    entry.torrent.select(fileIndexes).catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : String(error);
    });
  }

  public async status(handle: string): Promise<TorrentStatus | null> {
    const entry = this.entry(handle);
    if (!entry) return null;
    const { torrent } = entry;
    const base = { speedBytesPerSecond: Math.round(torrent.downloadRate), peers: torrent.peers.size };

    // A failed torrent, one still waiting for its file list, or one verifying data on disk
    if (entry.error) {
      return { ...base, state: "error", downloadedBytes: 0, totalBytes: 0, progress: 0, error: entry.error };
    }
    if (!torrent.info) return { ...base, state: "metadata", downloadedBytes: 0, totalBytes: 0, progress: 0 };
    if (torrent.state === "checking") return { ...base, state: "checking", downloadedBytes: 0, totalBytes: 0, progress: 0 };

    // Progress over the selected files only, counting verified pieces
    const selected = torrent.files().filter((file) => file.selected);
    const totalBytes = selected.reduce((sum, file) => sum + file.length, 0);
    const downloadedBytes = selected.reduce((sum, file) => sum + file.downloaded, 0);

    // Complete once every selected byte is verified on disk
    const complete = entry.started && (torrent.state === "done" || torrent.state === "seeding");
    return {
      ...base,
      state: complete ? "complete" : "downloading",
      downloadedBytes,
      totalBytes,
      progress: totalBytes > 0 ? downloadedBytes / totalBytes : complete ? 1 : 0,
    };
  }

  public async stop(handle: string): Promise<void> {
    const entry = this.entry(handle);
    if (!entry) return;

    // Disconnect every peer, so nothing reads or writes the files while they are processed
    entry.stopped = true;
    await entry.torrent.pause();
  }

  public async remove(handle: string): Promise<void> {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);

    // Closing deletes the files it wrote. A torrent the killswitch closed
    // stays closed, so its files are kept for the next attempt
    await TinyTorrentDownloader.within(entry.torrent.close({ deleteFiles: true }));
  }

  public async managed(): Promise<Map<string, string>> {
    return new Map([...this.entries.keys()].map((tag) => [tag, tag]));
  }

  public async disconnect(reason: string): Promise<void> {
    const engine = this.engine;
    this.engine = null;

    // Mark transfers first, so a poll racing the teardown sees the suspension
    // rather than a vanished torrent it would blame on the release
    for (const entry of this.entries.values()) {
      if (!entry.stopped) entry.suspended = reason;
    }
    if (!engine) return;

    // Then close every torrent, keeping its files, and every socket
    this.stopDhtSaving(engine);
    await TinyTorrentDownloader.within(engine.destroy());
  }

  // ---------- Engine ---------- //

  /**
   * The shared engine, created on first use. Throws `SuspendedError` while
   * the VPN killswitch holds traffic back.
   */
  private ensureEngine(): Engine {
    const guard = VpnGuard.getInstance();
    guard.assertAllowed();
    if (this.engine) return this.engine;

    // The port setting applies whenever an engine starts, so a change needs a restart
    const port = this.options.port ?? SettingsStore.section("torrent").port;
    const { discovery } = this.options;
    const engine = new Engine({
      port,
      transport: new VpnTransport(guard),
      dht: discovery ? TinyTorrentDownloader.savedDhtNodes() : false,
      pex: discovery,
      // Mapping requests go through the transport too, so behind the VPN they only reach its gateway
      portMapping: discovery,
    });

    // Engine warnings are never fatal: without its port, the engine still connects out
    engine.on("warning", (message: string) => console.warn(`[Downloader] ${TinyTorrentDownloader.explainWarning(message, port)}`));

    this.engine = engine;
    if (discovery) this.startDhtSaving(engine);
    return engine;
  }

  /** Looks up a torrent, first surfacing a killswitch suspension. */
  private entry(handle: string): Entry | undefined {
    const entry = this.entries.get(handle);
    if (entry?.suspended) throw new SuspendedError(entry.suspended);
    return entry;
  }

  /**
   * Applies the settings the engine reads live: the peer limit, and the
   * encryption policy. The VPN already encrypts, so behind it peers are
   * tried in plaintext first, which saves CPU; elsewhere connections are
   * obfuscated, which keeps them past ISPs that throttle BitTorrent.
   */
  private static applySettings(engine: Engine): void {
    engine.options.maxPeersPerTorrent = SettingsStore.section("torrent").maxConnections;
    engine.options.encryption = SettingsStore.section("vpn").enabled ? "prefer-plaintext" : "prefer";
  }

  /** Explains an engine warning in terms a user can act on, rather than the socket error. */
  public static explainWarning(message: string, port: number): string {
    if (!message.startsWith("Could not listen")) return message;
    if (message.includes("EADDRINUSE")) {
      return `Port ${port} is already in use by another program, so peers cannot connect in and downloads may be slower. Close that program, or choose a different torrent port in Settings.`;
    }
    if (message.includes("EACCES")) {
      return `Findr isn't allowed to use port ${port}, so peers cannot connect in and downloads may be slower. Choose a torrent port above 1024 in Settings.`;
    }
    return message;
  }

  // ---------- DHT nodes ---------- //

  /** The DHT nodes saved last run, as engine options. Saved nodes are a head start; the bootstrap routers still apply. */
  private static savedDhtNodes(): { nodes?: Uint8Array; nodes6?: Uint8Array } {
    const saved = DhtNodesSchema.safeParse(AppState.get(DHT_NODES_KEY));
    if (!saved.success) return {};
    const decode = (base64: string | undefined) => (base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined);
    return { nodes: decode(saved.data.nodes), nodes6: decode(saved.data.nodes6) };
  }

  /** Saves the engine's DHT nodes, if it has found any. */
  private static saveDhtNodes(engine: Engine): void {
    const nodes = engine.dhtNodes();
    const nodes6 = engine.dhtNodes6();
    if (!nodes?.length && !nodes6?.length) return;
    const encode = (bytes: Uint8Array | undefined) => (bytes?.length ? Buffer.from(bytes).toString("base64") : undefined);
    AppState.set(DHT_NODES_KEY, { nodes: encode(nodes), nodes6: encode(nodes6) });
  }

  /** Saves the DHT's nodes periodically, without keeping the process alive. */
  private startDhtSaving(engine: Engine): void {
    this.dhtSaveTimer = setInterval(() => TinyTorrentDownloader.saveDhtNodes(engine), DHT_SAVE_INTERVAL_MS);
    this.dhtSaveTimer.unref();
  }

  /** Stops the periodic save for an engine being torn down, saving one last time. */
  private stopDhtSaving(engine: Engine): void {
    if (!this.dhtSaveTimer) return;
    clearInterval(this.dhtSaveTimer);
    this.dhtSaveTimer = null;
    TinyTorrentDownloader.saveDhtNodes(engine);
  }

  // ---------- Helpers ---------- //

  /** Parses a magnet link or `.torrent` file, failing the attempt when it cannot be read. */
  private static parse(input: TorrentInput): Metainfo | Magnet {
    try {
      return input.kind === "magnet" ? parseMagnet(input.uri) : parseTorrent(input.bytes);
    } catch (error) {
      throw new AttemptFailure(`The torrent could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Waits for a teardown, but never longer than `CLOSE_TIMEOUT_MS`, so a stuck disk cannot hold up cleanup. */
  private static async within(teardown: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    });
    await Promise.race([teardown, timeout]).finally(() => clearTimeout(timer));
  }
}
