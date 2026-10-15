import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTorrentFromPath, Engine } from "tinytorrent";
import { SettingsStore } from "../db/models/SettingsStore";
import { AttemptFailure, SuspendedError } from "../pipeline/errors";
import VpnGuard from "../vpn/VpnGuard";
import { TinyTorrentDownloader } from "./TinyTorrentDownloader";

/**
 * Exercises the real TinyTorrent engine end to end without touching the
 * internet: a second engine seeds fixture files on localhost, and the
 * downloader under test reaches it through the peer address in a magnet
 * (`x.pe`), with trackers, the DHT, PEX and port mapping off on both sides.
 */

const MB = 1024 * 1024;

/** Polls until `check` returns a value, or fails after `timeoutMs`. */
async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting");
}

/** Waits for a torrent to finish downloading, returning its final status. */
function waitForComplete(downloader: TinyTorrentDownloader, handle: string) {
  return waitFor(async () => {
    const status = await downloader.status(handle);
    return status?.state === "complete" ? status : null;
  });
}

/** Lists every file under a directory, relative to it. */
async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
}

// ---------- Fixture swarm ---------- //

let scratch: string;
let seeder: Engine;
let torrentFile: Uint8Array<ArrayBuffer>;
let magnet: string;
let movie: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "findr-tinytorrent-"));

  // A two-file release: the feature and an extra that should never download.
  // The torrent is named after its folder
  const source = join(scratch, "Fixture.Movie.2024");
  await Bun.write(join(source, "Fixture.Movie.2024.mkv"), (movie = crypto.getRandomValues(new Uint8Array(3 * MB))));
  await writeFile(join(source, "Fixture.Movie.2024.nfo"), crypto.getRandomValues(new Uint8Array(MB)));
  torrentFile = new Uint8Array(await createTorrentFromPath(source, { pieceLength: 256 * 1024 }));

  // Seed it on a random localhost port, serving the files as they are
  seeder = new Engine({ dht: false, pex: false });
  const seeded = seeder.add(torrentFile, { dir: scratch, seedMode: true, seed: true });
  await seeder.ready();
  magnet = `magnet:?xt=urn:btih:${seeded.infoHashHex}&x.pe=127.0.0.1:${seeder.port()}`;
});

afterAll(async () => {
  await seeder.destroy();
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Downloader ---------- //

describe("TinyTorrentDownloader", () => {
  test("fetches the file list from a peer, downloads only the selected file, and deletes it on remove", async () => {
    const downloader = new TinyTorrentDownloader({ port: 0, discovery: false });
    const directory = join(scratch, "download-1");
    const handle = await downloader.add({ kind: "magnet", uri: magnet }, { directory, tag: "findr-a1" });

    // The file list arrives from the peer, relative to the save directory
    const files = await waitFor(() => downloader.files(handle));
    expect(files.map((file) => [file.path, file.sizeBytes])).toEqual([
      [join("Fixture.Movie.2024", "Fixture.Movie.2024.mkv"), 3 * MB],
      [join("Fixture.Movie.2024", "Fixture.Movie.2024.nfo"), MB],
    ]);

    // Nothing is requested or written before the pipeline chooses
    await Bun.sleep(500);
    expect(await listFiles(directory)).toEqual([]);
    expect(await downloader.status(handle)).toMatchObject({ state: "downloading", downloadedBytes: 0 });

    // Select the feature only and wait for it
    await downloader.start(handle, [0]);
    const done = await waitForComplete(downloader, handle);
    expect(done.progress).toBe(1);
    expect(done.totalBytes).toBe(3 * MB);
    expect(done.downloadedBytes).toBe(3 * MB);

    // The feature is intact, and the extra was never created
    const saved = join(directory, "Fixture.Movie.2024", "Fixture.Movie.2024.mkv");
    expect(new Uint8Array(await Bun.file(saved).arrayBuffer())).toEqual(movie);
    expect(await listFiles(directory)).toEqual([join("Fixture.Movie.2024", "Fixture.Movie.2024.mkv")]);

    // Stop, then remove deletes what it wrote and forgets the torrent
    await downloader.stop(handle);
    expect([...(await downloader.managed()).keys()]).toEqual(["findr-a1"]);
    await downloader.remove(handle);
    expect(await listFiles(directory)).toEqual([]);
    expect((await downloader.managed()).size).toBe(0);
    expect(await downloader.status(handle)).toBeNull();
    await downloader.disconnect("test finished");
  }, 30_000);

  test("a .torrent file is ready without any peers", async () => {
    const downloader = new TinyTorrentDownloader({ port: 0, discovery: false });
    const handle = await downloader.add({ kind: "file", bytes: torrentFile }, { directory: join(scratch, "download-2"), tag: "findr-a2" });

    expect(await downloader.files(handle)).toHaveLength(2);
    await downloader.remove(handle);
    await downloader.disconnect("test finished");
  });

  test("a release another attempt is already downloading fails that attempt only", async () => {
    const downloader = new TinyTorrentDownloader({ port: 0, discovery: false });
    const input = { kind: "file" as const, bytes: torrentFile };
    const first = await downloader.add(input, { directory: join(scratch, "download-3a"), tag: "findr-a3" });

    await expect(downloader.add(input, { directory: join(scratch, "download-3b"), tag: "findr-a4" })).rejects.toBeInstanceOf(AttemptFailure);
    expect(await downloader.files(first)).toHaveLength(2);
    await downloader.remove(first);
    await downloader.disconnect("test finished");
  });

  test("an unreadable .torrent fails the attempt", async () => {
    const downloader = new TinyTorrentDownloader({ port: 0, discovery: false });
    const adding = downloader.add({ kind: "file", bytes: new TextEncoder().encode("not a torrent") }, { directory: join(scratch, "download-4"), tag: "findr-a5" });

    await expect(adding).rejects.toBeInstanceOf(AttemptFailure);
    expect((await downloader.managed()).size).toBe(0);
  });

  test("a port already in use is explained, and downloads still run over outgoing connections", async () => {
    // Hold a port on the dual-stack address the engine listens on
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("No port");

    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const downloader = new TinyTorrentDownloader({ port: address.port, discovery: false });
    try {
      const handle = await downloader.add({ kind: "magnet", uri: magnet }, { directory: join(scratch, "download-5"), tag: "findr-a6" });
      await waitFor(() => downloader.files(handle));
      await downloader.start(handle, [0]);
      await waitForComplete(downloader, handle);

      // The user is told what to do, not shown the socket error
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes(`Port ${address.port} is already in use`))).toBe(true);
      expect(messages.some((message) => message.includes("EADDRINUSE"))).toBe(false);
      await downloader.remove(handle);
    } finally {
      warn.mockRestore();
      blocker.close();
      await downloader.disconnect("test finished");
    }
  }, 30_000);

  test("the killswitch keeps a transfer's files, and adding it again in the same directory carries on from the intact pieces", async () => {
    const directory = join(scratch, "download-8");
    const saved = join(directory, "Fixture.Movie.2024", "Fixture.Movie.2024.mkv");

    // A transfer under way when the VPN drops
    const first = new TinyTorrentDownloader({ port: 0, discovery: false });
    const handle = await first.add({ kind: "magnet", uri: magnet }, { directory, tag: "findr-a8" });
    await waitFor(() => first.files(handle));
    await first.start(handle, [0]);
    await waitForComplete(first, handle);
    await first.disconnect("The VPN is down");

    // It is suspended, and neither the cut nor the attempt's cleanup deletes its files
    await expect(first.status(handle)).rejects.toBeInstanceOf(SuspendedError);
    await first.remove(handle);
    expect(new Uint8Array(await Bun.file(saved).arrayBuffer())).toEqual(movie);

    // Damage the second half, as if the transfer had stopped midway
    const damaged = movie.slice();
    damaged.fill(0, movie.length / 2);
    await Bun.write(saved, damaged);

    // Added again with no peer to fetch from, it verifies what is on disk and
    // counts only the intact pieces
    const second = new TinyTorrentDownloader({ port: 0, discovery: false });
    const again = await second.add({ kind: "file", bytes: torrentFile }, { directory, tag: "findr-a9" });
    await second.start(again, [0]);
    const resumed = await waitFor(async () => {
      const status = await second.status(again);
      return status?.state === "downloading" ? status : null;
    });
    expect(resumed.progress).toBe(0.5);

    await second.remove(again);
    await second.disconnect("test finished");
  }, 30_000);

  test("applies the peer limit and encryption policy from the settings on every add", async () => {
    const downloader = new TinyTorrentDownloader({ port: 0, discovery: false });
    const input = { kind: "file" as const, bytes: torrentFile };
    const engineOf = () => (downloader as unknown as { engine: Engine }).engine;
    try {
      SettingsStore.update({ torrent: { maxConnections: 80 } });
      const first = await downloader.add(input, { directory: join(scratch, "download-6a"), tag: "findr-a6" });
      expect(engineOf().options.maxPeersPerTorrent).toBe(80);
      expect(engineOf().options.encryption).toBe("prefer");
      await downloader.remove(first);

      // A changed setting reaches the running engine without a restart
      SettingsStore.update({ torrent: { maxConnections: 200 } });
      const second = await downloader.add(input, { directory: join(scratch, "download-6b"), tag: "findr-a7" });
      expect(engineOf().options.maxPeersPerTorrent).toBe(200);
      await downloader.remove(second);
    } finally {
      SettingsStore.update({ torrent: { maxConnections: 150 } });
      await downloader.disconnect("test finished");
    }
  });
});

// ---------- VPN killswitch ---------- //

describe("TinyTorrentDownloader behind the VPN killswitch", () => {
  /** Whether the fake tunnel is up; its address is loopback, so the fixture swarm is reachable through it. */
  let tunnel = true;
  const guard = VpnGuard.getInstance();

  beforeAll(async () => {
    guard.useProbes({
      interfaces: () =>
        tunnel
          ? { wg0: [{ address: "127.0.0.1", internal: false, family: "IPv4", netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: "127.0.0.1/8" }] }
          : {},
      route: async (destination) => (tunnel && !destination.includes(":") ? "127.0.0.1" : null),
      watchRoutes: () => null,
      publicIp: async () => "203.0.113.9",
    });
    SettingsStore.update({ vpn: { enabled: true, interfaceName: "wg0" } });
    await guard.check();
  });

  afterAll(async () => {
    SettingsStore.update({ vpn: { enabled: false } });
    await guard.check();
  });

  test("downloads through the VPN's address, trying peers in plaintext first, and refuses to start while it is down", async () => {
    const downloader = new TinyTorrentDownloader({ port: 0, discovery: false });
    try {
      const handle = await downloader.add({ kind: "magnet", uri: magnet }, { directory: join(scratch, "download-9"), tag: "findr-a10" });
      const engine = (downloader as unknown as { engine: Engine }).engine;
      expect(engine.transport.localAddress()).toBe("127.0.0.1");
      expect(engine.options.encryption).toBe("prefer-plaintext");

      await waitFor(() => downloader.files(handle));
      await downloader.start(handle, [0]);
      await waitForComplete(downloader, handle);
      await downloader.remove(handle);

      // The tunnel drops: nothing new may start
      tunnel = false;
      await guard.check();
      await downloader.disconnect("The VPN is down");
      const adding = downloader.add({ kind: "magnet", uri: magnet }, { directory: join(scratch, "download-10"), tag: "findr-a11" });
      await expect(adding).rejects.toBeInstanceOf(SuspendedError);
    } finally {
      tunnel = true;
      await guard.check();
      await downloader.disconnect("test finished");
    }
  }, 30_000);
});
