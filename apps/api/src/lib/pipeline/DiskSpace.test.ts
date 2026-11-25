import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSpace, StatfsProbe, type Volume, type VolumeProbe } from "./DiskSpace";
import { OutOfSpaceError } from "./errors";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * Disks of any size: each path prefix maps to a device and its free bytes,
 * and each workspace to the bytes it holds, which a test moves to mimic a
 * transfer under way.
 */
class FakeProbe implements VolumeProbe {
  public readonly disks = new Map<string, Volume>();
  public readonly held = new Map<string, number>();

  public async volume(path: string): Promise<Volume | null> {
    const prefix = [...this.disks.keys()].filter((key) => path.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    return prefix ? (this.disks.get(prefix) ?? null) : null;
  }

  public async allocated(path: string): Promise<number> {
    return this.held.get(path) ?? 0;
  }
}

/** A space checker over two disks: downloads (`/scratch`) and a separate library (`/library`). */
function twoDisks(scratchFree: number, libraryFree: number) {
  const probe = new FakeProbe();
  probe.disks.set("/scratch", { device: 1, freeBytes: scratchFree });
  probe.disks.set("/library", { device: 2, freeBytes: libraryFree });
  return { probe, space: new DiskSpace(probe, GB) };
}

/** A request for a release of `bytes`, from the attempt workspace `name`. */
function request(bytes: number, name = "a", library = "/library/movies") {
  return { downloads: "/scratch", workspace: `/scratch/d/${name}`, library, bytes };
}

describe("DiskSpace", () => {
  test("lets an attempt through when the downloads disk holds twice the release plus the margin", async () => {
    const { space } = twoDisks(9 * GB, 100 * GB);
    const reservation = await space.reserve(request(4 * GB));
    reservation.release();
  });

  test("refuses a release the downloads disk cannot hold, naming the folder and both figures", async () => {
    const { space } = twoDisks(8.5 * GB, 100 * GB);
    const refusal = space.reserve(request(4 * GB));
    await expect(refusal).rejects.toBeInstanceOf(OutOfSpaceError);
    await expect(refusal).rejects.toThrow(
      "Not enough disk space: this release needs 9.0 GB free in the downloads folder (/scratch), and only 8.5 GB is available. Free some space, then retry.",
    );
  });

  test("refuses a release a separate library disk cannot hold", async () => {
    const { space } = twoDisks(100 * GB, 4.5 * GB);
    await expect(space.reserve(request(4 * GB))).rejects.toThrow("needs 5.0 GB free in the library (/library/movies)");
  });

  test("a library on the downloads disk costs nothing extra, since the save is a rename", async () => {
    const { space } = twoDisks(9.5 * GB, 0);
    const reservation = await space.reserve(request(4 * GB, "a", "/scratch/library"));
    reservation.release();
  });

  test("counts what a paused transfer already left in its workspace", async () => {
    const { probe, space } = twoDisks(6 * GB, 100 * GB);
    await expect(space.reserve(request(4 * GB))).rejects.toBeInstanceOf(OutOfSpaceError);

    // Three of the four gigabytes are already on disk, so only five more are needed
    probe.held.set("/scratch/d/a", 3 * GB);
    (await space.reserve(request(4 * GB))).release();
  });

  test("attempts side by side account for each other until they end", async () => {
    const { probe, space } = twoDisks(13 * GB, 100 * GB);
    const first = await space.reserve(request(4 * GB, "a"));

    // The first still has 8 GB to write, so a second 4 GB release no longer fits
    await expect(space.reserve(request(4 * GB, "b"))).rejects.toBeInstanceOf(OutOfSpaceError);

    // As the first writes, the disk's free space falls by as much as its claim does
    probe.held.set("/scratch/d/a", 6 * GB);
    probe.disks.set("/scratch", { device: 1, freeBytes: 7 * GB });
    await expect(space.reserve(request(4 * GB, "b"))).rejects.toBeInstanceOf(OutOfSpaceError);

    // Once it ends and its files are gone, the room is free again
    first.release();
    probe.held.delete("/scratch/d/a");
    probe.disks.set("/scratch", { device: 1, freeBytes: 13 * GB });
    (await space.reserve(request(4 * GB, "b"))).release();
  });

  test("a library claim stands for the whole attempt", async () => {
    const { space } = twoDisks(100 * GB, 8.5 * GB);
    const first = await space.reserve(request(4 * GB, "a"));
    await expect(space.reserve(request(4 * GB, "b"))).rejects.toThrow("only 4.5 GB is available");
    first.release();
    (await space.reserve(request(4 * GB, "b"))).release();
  });

  test("checks started together never both count the same free bytes", async () => {
    const { space } = twoDisks(13 * GB, 100 * GB);
    const outcomes = await Promise.allSettled([space.reserve(request(4 * GB, "a")), space.reserve(request(4 * GB, "b"))]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
  });

  test("a disk it cannot read lets the attempt through, and a failed check holds nothing", async () => {
    const probe = new FakeProbe();
    const space = new DiskSpace(probe, GB);
    (await space.reserve(request(400 * GB))).release();

    // The refused attempt left no claim behind to squeeze the next one
    probe.disks.set("/scratch", { device: 1, freeBytes: 9 * GB });
    await expect(space.reserve(request(5 * GB, "a"))).rejects.toBeInstanceOf(OutOfSpaceError);
    (await space.reserve(request(4 * GB, "b"))).release();
  });

  test("an unset library is left for the saver to report", async () => {
    const { space } = twoDisks(9 * GB, 0);
    (await space.reserve(request(4 * GB, "a", ""))).release();
  });

  test("recognises a full disk by error code, message, cause or process output", () => {
    const coded = Object.assign(new Error("write failed"), { code: "ENOSPC" });
    const quota = Object.assign(new Error("write failed"), { code: "EDQUOT" });
    expect(DiskSpace.isNoSpace(coded)).toBe(true);
    expect(DiskSpace.isNoSpace(quota)).toBe(true);
    expect(DiskSpace.isNoSpace(new Error("ENOSPC: no space left on device, write"))).toBe(true);
    expect(DiskSpace.isNoSpace(new Error("wrapped", { cause: coded }))).toBe(true);
    expect(DiskSpace.isNoSpace("[matroska @ 0x1] Error writing trailer: No space left on device")).toBe(true);

    expect(DiskSpace.isNoSpace(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(DiskSpace.isNoSpace("Invalid data found when processing input")).toBe(false);
    expect(DiskSpace.isNoSpace(null)).toBe(false);
  });
});

describe("StatfsProbe", () => {
  let root: string;
  const probe = new StatfsProbe();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "findr-diskspace-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reads the volume of a folder that does not exist yet from its nearest parent", async () => {
    const existing = await probe.volume(root);
    const missing = await probe.volume(join(root, "library", "Some Movie (2024)"));
    expect(existing?.freeBytes).toBeGreaterThan(0);
    expect(missing).toEqual({ device: existing?.device ?? -1, freeBytes: expect.any(Number) });
  });

  test("counts sparse torrent files by what they hold, not their length", async () => {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "payload"), { recursive: true });

    // A 2 GB file the torrent engine has only sized, plus 4 MB actually written
    const sparse = await open(join(workspace, "payload", "movie.mkv"), "w");
    await sparse.truncate(2 * GB);
    await sparse.close();
        await writeFile(join(workspace, "output.mkv"), new Uint8Array(4 * MB).fill(1));

    const allocated = await probe.allocated(workspace);
    expect(allocated).toBeGreaterThanOrEqual(4 * MB);
    expect(allocated).toBeLessThan(64 * MB);
    expect(await probe.allocated(join(root, "nothing-here"))).toBe(0);
  });
});
