/**
 * Tests of the updater against a fake GitHub served locally: what counts as
 * an update, conditional checks, what blocks an install, the swap itself and
 * its failure paths, and automatic installs. The "executable" is a file in a
 * temporary directory, and restarting is recorded rather than done.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { Download } from "../db/models/Download";
import { SettingsStore } from "../db/models/SettingsStore";
import DownloadQueue from "../pipeline/DownloadQueue";
import Updater, { UpdateError, type UpdaterHost } from "./Updater";

// ---------- Fake GitHub ---------- //

const NEW_BINARY = "#!/bin/sh\necho new\n";

/** What the fake release endpoint currently serves. */
let release: { tag: string; assets: string[] } | null;
let feedStatus: number;
let checksum: string;
let assetStatus: number;
let requests: { etag: string | null }[];
let downloads: number;

const github = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/latest") {
      requests.push({ etag: request.headers.get("if-none-match") });
      if (feedStatus !== 200) return new Response("", { status: feedStatus });
      if (!release) return new Response("", { status: 404 });
      const etag = `"${release.tag}"`;
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
      return Response.json(
        {
          tag_name: release.tag,
          html_url: `https://github.com/example/findr/releases/tag/${release.tag}`,
          body: "Fixes things.",
          published_at: "2026-10-01T00:00:00Z",
          assets: release.assets.map((name) => ({ name, browser_download_url: `${url.origin}/download/${name}` })),
        },
        { headers: { etag } },
      );
    }
    if (url.pathname === "/download/SHA256SUMS.txt") return new Response(`${checksum}  findr-linux-x64\nabc  findr-darwin-arm64\n`);
    if (url.pathname === "/download/findr-linux-x64") {
      downloads++;
      return new Response(assetStatus === 200 ? NEW_BINARY : "", { status: assetStatus });
    }
    return new Response("", { status: 404 });
  },
});

// ---------- Host ---------- //

let directory: string;
let executable: string;
let restarts: number;
let restarted: Promise<void>;

/** A binary install of 2.0.1 for linux-x64 in a temporary directory. */
function host(overrides: Partial<UpdaterHost> = {}): UpdaterHost {
  let resolve: () => void = () => undefined;
  restarted = new Promise((done) => (resolve = done));
  return {
    version: "2.0.1",
    target: "linux-x64",
    container: false,
    executable,
    feedUrl: `${github.url.origin}/latest`,
    restart: () => {
      restarts++;
      resolve();
    },
    ...overrides,
  };
}

const updater = Updater.getInstance();
const queue = DownloadQueue.getInstance();

/** Resolves once the background install has finished, one way or the other. */
async function settled(): Promise<void> {
  while (updater.status.phase === "downloading") await Bun.sleep(5);
}

/** The account downloads in these tests are requested by. */
const USER = "updater-test";

beforeAll(async () => {
  await migrateAuth();
  database
    .query("INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ($id, 'Test', 'test@findr.local', 1, 0, 0)")
    .run({ id: USER });
});

beforeEach(async () => {
  database.run("DELETE FROM app_state");
  database.run("DELETE FROM settings");
  release = { tag: "v2.1.0", assets: ["findr-linux-x64", "findr-darwin-arm64", "SHA256SUMS.txt"] };
  feedStatus = 200;
  checksum = new Bun.CryptoHasher("sha256").update(NEW_BINARY).digest("hex");
  assetStatus = 200;
  requests = [];
  downloads = 0;
  restarts = 0;
  directory = await mkdtemp(join(tmpdir(), "findr-updater-"));
  executable = join(directory, "findr");
  await Bun.write(executable, "old");
  updater.useHost(host());
});

afterEach(async () => {
  updater.stop();
  queue.release();
  await chmod(directory, 0o755);
  await rm(directory, { recursive: true, force: true });
});

afterAll(() => github.stop(true));

// ---------- Checking ---------- //

describe("checking", () => {
  test("reports a newer release as available", async () => {
    const status = await updater.check();
    expect(status).toMatchObject({
      current: "2.0.1",
      install: "binary",
      available: true,
      blocked: null,
      error: null,
      phase: "idle",
      latest: { version: "2.1.0", notes: "Fixes things.", publishedAt: "2026-10-01T00:00:00Z" },
    });
    expect(status.checkedAt).toBeNumber();
  });

  test("an equal or older release is not an update", async () => {
    release = { tag: "v2.0.1", assets: [] };
    expect((await updater.check()).available).toBe(false);

    updater.useHost(host({ version: "3.0.0" }));
    release = { tag: "v2.5.0", assets: [] };
    const status = await updater.check();
    expect(status.available).toBe(false);
    expect(status.latest?.version).toBe("2.5.0");
  });

  test("a tag that is not a version is never an update", async () => {
    release = { tag: "nightly", assets: [] };
    expect((await updater.check()).available).toBe(false);
  });

  test("asks again conditionally and keeps the release on a 304", async () => {
    const first = await updater.check();
    await Bun.sleep(2);
    const second = await updater.check();

    expect(requests).toEqual([{ etag: null }, { etag: '"v2.1.0"' }]);
    expect(second.latest).toEqual(first.latest);
    expect(second.checkedAt).toBeGreaterThan(first.checkedAt ?? Infinity);
  });

  test("concurrent checks share one request", async () => {
    await Promise.all([updater.check(), updater.check(), updater.check()]);
    expect(requests).toHaveLength(1);
  });

  test("a repository without releases has nothing to offer", async () => {
    release = null;
    const status = await updater.check();
    expect(status).toMatchObject({ latest: null, available: false, error: null });
  });

  test("a failed check reports why and keeps the last answer", async () => {
    await updater.check();
    feedStatus = 503;
    const status = await updater.check();
    expect(status.error).toContain("503");
    expect(status.latest?.version).toBe("2.1.0");

    // The next success clears it
    feedStatus = 200;
    expect((await updater.check()).error).toBeNull();
  });

  test("the last answer survives a restart", async () => {
    await updater.check();
    updater.useHost(host());
    expect(updater.status.latest?.version).toBe("2.1.0");
  });
});

// ---------- Blocking ---------- //

describe("what blocks an install", () => {
  test("a source checkout is only told", async () => {
    updater.useHost(host({ target: null }));
    const status = await updater.check();
    expect(status).toMatchObject({ install: "source", available: true, blocked: "source_install" });
    expect(() => updater.install()).toThrow(UpdateError);
  });

  test("a container is only told, even when it holds a compiled executable", async () => {
    updater.useHost(host({ container: true }));
    const status = await updater.check();
    expect(status).toMatchObject({ install: "docker", available: true, blocked: "docker_install" });
    expect(() => updater.install()).toThrow(expect.objectContaining({ code: "docker_install" }));
    expect(downloads).toBe(0);
  });

  test("a platform the release has no executable for", async () => {
    updater.useHost(host({ target: "windows-x64" }));
    expect((await updater.check()).blocked).toBe("no_asset");
  });

  test("an executable in a directory that cannot be written", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    await chmod(directory, 0o555);
    expect((await updater.check()).blocked).toBe("not_writable");
  });

  test("queued or running downloads", async () => {
    await updater.check();
    queue.hold();
    const download = queue.enqueue(603, "movie", null, USER);
    try {
      expect(updater.status.blocked).toBe("downloads_active");
      expect(() => updater.install()).toThrow(expect.objectContaining({ code: "downloads_active" }));
    } finally {
      await queue.cancel(download.id);
    }
    expect(updater.status.blocked).toBeNull();
  });

  test("nothing newer", async () => {
    release = { tag: "v2.0.1", assets: ["findr-linux-x64"] };
    await updater.check();
    expect(() => updater.install()).toThrow(expect.objectContaining({ code: "no_update" }));
  });
});

// ---------- Installing ---------- //

describe("installing", () => {
  test("swaps the executable in and restarts", async () => {
    let freed = 0;
    updater.start(() => void freed++);
    updater.stop();
    await updater.check();

    const status = updater.install();
    expect(status.phase).toBe("downloading");
    expect(() => updater.install()).toThrow(expect.objectContaining({ code: "update_in_progress" }));

    await restarted;
    expect(await Bun.file(executable).text()).toBe(NEW_BINARY);
    expect((await stat(executable)).mode & 0o777).toBe(0o755);
    expect(await readdir(directory)).toEqual(["findr"]);
    expect(updater.status.phase).toBe("restarting");
    expect(freed).toBe(1);
    expect(restarts).toBe(1);
  });

  test("holds the queue while installing", async () => {
    await updater.check();
    updater.install();
    const download = queue.enqueue(604, "movie", null, USER);
    try {
      await restarted;
      expect(queue.busy).toBe(true);
      expect(Download.find(download.id)?.status).toBe("queued");
    } finally {
      await queue.cancel(download.id);
    }
  });

  test("a checksum mismatch leaves the executable alone", async () => {
    checksum = "0".repeat(64);
    await updater.check();
    updater.install();
    await settled();

    expect(await Bun.file(executable).text()).toBe("old");
    expect(await readdir(directory)).toEqual(["findr"]);
    expect(updater.status).toMatchObject({ phase: "idle", available: true, blocked: null });
    expect(updater.status.error).toContain("checksum");
    expect(restarts).toBe(0);
  });

  test("a failed download leaves the executable alone and lets the queue go", async () => {
    assetStatus = 502;
    await updater.check();
    updater.install();
    await settled();

    expect(await Bun.file(executable).text()).toBe("old");
    expect(await readdir(directory)).toEqual(["findr"]);
    expect(updater.status.error).toContain("502");
    expect(restarts).toBe(0);
  });

  test("picks the .exe a Windows release ships", async () => {
    release = { tag: "v2.1.0", assets: ["findr-windows-x64.exe"] };
    updater.useHost(host({ target: "windows-x64" }));
    expect((await updater.check()).blocked).toBeNull();
  });
});

// ---------- Automatic installs ---------- //

describe("automatic installs", () => {
  test("installs on startup when turned on and the queue is empty", async () => {
    SettingsStore.update({ updates: { autoInstall: true } });
    updater.start(() => undefined);
    await restarted;
    expect(await Bun.file(executable).text()).toBe(NEW_BINARY);
  });

  test("waits while downloads are queued", async () => {
    SettingsStore.update({ updates: { autoInstall: true } });
    queue.hold();
    const download = queue.enqueue(605, "movie", null, USER);
    try {
      updater.start(() => undefined);
      await Bun.sleep(50);
      expect(updater.status).toMatchObject({ available: true, blocked: "downloads_active", phase: "idle" });
      expect(restarts).toBe(0);
    } finally {
      await queue.cancel(download.id);
    }
  });

  test("never installs in a container, even when turned on", async () => {
    SettingsStore.update({ updates: { autoInstall: true } });
    updater.useHost(host({ container: true }));
    updater.start(() => undefined);
    await Bun.sleep(50);
    expect(updater.status).toMatchObject({ available: true, blocked: "docker_install", phase: "idle" });
    expect(downloads).toBe(0);
    expect(await Bun.file(executable).text()).toBe("old");
  });

  test("does nothing when turned off", async () => {
    updater.start(() => undefined);
    await Bun.sleep(50);
    expect(updater.status).toMatchObject({ available: true, phase: "idle" });
    expect(await Bun.file(executable).text()).toBe("old");
  });

  test("does not retry a version that failed to install", async () => {
    SettingsStore.update({ updates: { autoInstall: true } });
    checksum = "0".repeat(64);
    updater.start(() => undefined);
    await Bun.sleep(50);
    await settled();
    expect(downloads).toBe(1);

    // The next tick finds the same version and leaves it be
    updater.stop();
    updater.start(() => undefined);
    await Bun.sleep(50);
    expect(updater.status.phase).toBe("idle");
    expect(downloads).toBe(1);
    expect(updater.status.error).toContain("checksum");
  });
});
