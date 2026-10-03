import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import { AttemptFailure, FatalDownloadError } from "../pipeline/errors";
import { WebTorrentDownloader } from "./WebTorrentDownloader";

/**
 * Exercises the real WebTorrent client end to end without touching the
 * internet: a second client seeds fixture files on localhost, and the
 * downloader under test reaches it through the peer address in a magnet
 * (`x.pe`), with trackers, DHT and LSD switched off on both sides.
 */

const MB = 1024 * 1024;

/** Options for a client that only talks to peers it is handed. */
const ISOLATED = { utp: false, dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false, torrentPort: 0 };

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

/** Lists every file under a directory, relative to it. */
async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
}

// ---------- Fixture swarm ---------- //

let scratch: string;
let seeder: WebTorrent;
let seeded: Torrent;
let magnet: string;
let movie: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "findr-webtorrent-"));

  // A two-file release: the feature and an extra that should never download.
  // Seeding the folder names the torrent after it
  const source = join(scratch, "Fixture.Movie.2024");
  await Bun.write(join(source, "Fixture.Movie.2024.mkv"), (movie = crypto.getRandomValues(new Uint8Array(3 * MB))));
  await writeFile(join(source, "Fixture.Movie.2024.nfo"), crypto.getRandomValues(new Uint8Array(MB)));

  // Seed it on a random localhost port
  seeder = new WebTorrent(ISOLATED);
  seeded = await new Promise<Torrent>((resolve) => seeder.seed(source, { announce: [] }, resolve));
  const port = await waitFor(async () => {
    const address = seeder.address();
    return address && typeof address !== "string" && address.port > 0 ? address.port : null;
  });
  magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&x.pe=127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Downloader ---------- //

describe("WebTorrentDownloader", () => {
  test("fetches the file list from a peer, downloads only the selected file, and deletes it on remove", async () => {
    const downloader = new WebTorrentDownloader({ port: 0, discovery: false });
    const directory = join(scratch, "download-1");
    const handle = await downloader.add({ kind: "magnet", uri: magnet }, { directory, tag: "findr-a1" });

    // The file list arrives over ut_metadata
    const files = await waitFor(() => downloader.files(handle));
    expect(files.map((file) => [file.path, file.sizeBytes])).toEqual([
      [join("Fixture.Movie.2024", "Fixture.Movie.2024.mkv"), 3 * MB],
      [join("Fixture.Movie.2024", "Fixture.Movie.2024.nfo"), MB],
    ]);

    // Nothing is written before the pipeline chooses
    await Bun.sleep(500);
    expect(await listFiles(directory)).toEqual([]);
    expect((await downloader.status(handle))?.state).toBe("downloading");

    // Select the feature only and wait for it
    await downloader.start(handle, [0]);
    const done = await waitFor(async () => {
      const status = await downloader.status(handle);
      return status?.state === "complete" ? status : null;
    });
    expect(done.progress).toBe(1);
    expect(done.totalBytes).toBe(3 * MB);

    // The feature is intact; the extra is at most the piece it shares with the feature
    const saved = join(directory, "Fixture.Movie.2024", "Fixture.Movie.2024.mkv");
    expect(new Uint8Array(await Bun.file(saved).arrayBuffer())).toEqual(movie);
    const extra = await stat(join(directory, "Fixture.Movie.2024", "Fixture.Movie.2024.nfo")).catch(() => null);
    expect(extra === null || extra.blocks * 512 <= seeded.pieceLength).toBe(true);

    // Stop, then remove deletes what it wrote and forgets the torrent
    await downloader.stop(handle);
    expect([...(await downloader.managed()).keys()]).toEqual(["findr-a1"]);
    await downloader.remove(handle);
    expect(await listFiles(directory)).toEqual([]);
    expect((await downloader.managed()).size).toBe(0);
    expect(await downloader.status(handle)).toBeNull();
  }, 30_000);

  test("a .torrent file is ready without any peers", async () => {
    const downloader = new WebTorrentDownloader({ port: 0, discovery: false });
    const handle = await downloader.add(
      { kind: "file", bytes: new Uint8Array(seeded.torrentFile) },
      { directory: join(scratch, "download-2"), tag: "findr-a2" },
    );

    const files = await waitFor(() => downloader.files(handle));
    expect(files).toHaveLength(2);
    await downloader.remove(handle);
  });

  test("a duplicate torrent fails that attempt only", async () => {
    const downloader = new WebTorrentDownloader({ port: 0, discovery: false });
    const input = { kind: "file" as const, bytes: new Uint8Array(seeded.torrentFile) };
    const first = await downloader.add(input, { directory: join(scratch, "download-3a"), tag: "findr-a3" });
    const second = await downloader.add(input, { directory: join(scratch, "download-3b"), tag: "findr-a4" });

    expect(await waitFor(() => downloader.files(first))).toHaveLength(2);
    const failure = await waitFor(() => downloader.files(second).then(() => null, (error: unknown) => error));
    expect(failure).toBeInstanceOf(AttemptFailure);

    // Removing a torrent that already failed returns rather than hanging
    await downloader.remove(second);
    await downloader.remove(first);
  });

  test("an unreadable .torrent fails the attempt", async () => {
    const downloader = new WebTorrentDownloader({ port: 0, discovery: false });
    const handle = await downloader.add(
      { kind: "file", bytes: new TextEncoder().encode("not a torrent") },
      { directory: join(scratch, "download-4"), tag: "findr-a5" },
    );

    const failure = await waitFor(() => downloader.files(handle).then(() => null, (error: unknown) => error));
    expect(failure).toBeInstanceOf(AttemptFailure);
    await downloader.remove(handle);
  });

  test("a port already in use is an environment failure, not the release's", async () => {
    // Hold a port on the dual-stack address the client listens on
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("No port");

    const downloader = new WebTorrentDownloader({ port: address.port, discovery: false });
    try {
      const handle = await downloader.add(
        { kind: "file", bytes: new Uint8Array(seeded.torrentFile) },
        { directory: join(scratch, "download-5"), tag: "findr-a6" },
      );
      const failure = await waitFor(() =>
        downloader.status(handle).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(FatalDownloadError);
      // The user is told what to do, not shown the socket error
      expect((failure as Error).message).toContain(`port ${address.port} is already in use`);
      expect((failure as Error).message).not.toContain("EADDRINUSE");
    } finally {
      blocker.close();
    }
  });
});

// ---------- Single teardown ---------- //

describe("WebTorrentDownloader.destroyOnce", () => {
  test("the installed WebTorrent still has the method it wraps", () => {
    const client = new WebTorrent(ISOLATED);
    try {
      expect(WebTorrentDownloader.destroyOnce(client)).toBe(true);
    } finally {
      client.destroy();
    }
  });

  test("ignores a second teardown, as when both the listener and the DHT fail", () => {
    let teardowns = 0;
    const client = {
      destroyed: false,
      _destroy(this: { destroyed: boolean }) {
        teardowns++;
        this.destroyed = true;
      },
    };
    const internals = client as unknown as { _destroy: (error: Error) => void };
    WebTorrentDownloader.destroyOnce(client as unknown as WebTorrent);

    internals._destroy(new Error("listen EADDRINUSE"));
    internals._destroy(new Error("bind EADDRINUSE"));
    expect(teardowns).toBe(1);
  });
});

// ---------- Request gate ---------- //

describe("WebTorrentDownloader.gateRequests", () => {
  test("the installed WebTorrent still has the method the gate wraps", () => {
    const client = new WebTorrent(ISOLATED);
    const torrent = client.add(Buffer.from(seeded.torrentFile), { path: join(scratch, "gate"), deselect: true });
    try {
      expect(WebTorrentDownloader.gateRequests(torrent, () => false)).toBe(true);
    } finally {
      client.destroy();
    }
  });

  test("refuses block requests until opened, then passes them through", () => {
    const calls: unknown[][] = [];
    const torrent = {
      _request: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    };
    let open = false;
    const gated = torrent as unknown as Torrent;
    WebTorrentDownloader.gateRequests(gated, () => open);
    const request = () => (gated as unknown as { _request: (...args: unknown[]) => boolean })._request("wire", 7, false);

    expect(request()).toBe(false);
    expect(calls).toHaveLength(0);

    open = true;
    expect(request()).toBe(true);
    expect(calls).toEqual([["wire", 7, false]]);
  });
});

// ---------- Killswitch transports ---------- //

describe("WebTorrentDownloader.restrictToBoundTransports", () => {
  test("the installed WebTorrent still has the methods it wraps", () => {
    const client = new WebTorrent(ISOLATED);
    const torrent = client.add(Buffer.from(seeded.torrentFile), { path: join(scratch, "restrict"), deselect: true });
    try {
      expect(WebTorrentDownloader.restrictToBoundTransports(torrent)).toBe(true);
    } finally {
      client.destroy();
    }
  });

  test("keeps only UDP trackers, and never fetches metadata over HTTP", () => {
    const seen: string[][] = [];
    let fetched = false;
    const torrent = {
      announce: ["udp://tracker.example:1337/announce", "https://tracker.example/announce", "http://tracker.example/announce"],
      _startDiscovery(this: { announce: string[] }) {
        seen.push(this.announce);
      },
      _getMetadataFromServer: () => {
        fetched = true;
      },
    };
    const internals = torrent as unknown as { _startDiscovery: () => void; _getMetadataFromServer: () => void };
    WebTorrentDownloader.restrictToBoundTransports(torrent as unknown as Torrent);

    internals._getMetadataFromServer();
    internals._startDiscovery();
    expect(fetched).toBe(false);
    expect(seen).toEqual([["udp://tracker.example:1337/announce"]]);
  });
});
