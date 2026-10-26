import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegLocator } from "./FfmpegLocator";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "findr-tools-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A gzipped "binary" on disk, as the build embeds one, with the hash of its contents. */
async function embedded(contents: string): Promise<{ file: string; sha256: string }> {
  const bytes = new TextEncoder().encode(contents);
  const file = join(root, `${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.gz`);
  await writeFile(file, Bun.gzipSync(bytes));
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("FfmpegLocator", () => {
  test("unpacks an embedded binary into a folder named by its hash, runnable only by its owner", async () => {
    const tool = await embedded("#!/bin/sh\necho ffmpeg version 9.0.2\n");
    const path = await FfmpegLocator.unpack("ffmpeg", tool, join(root, "bin"));

    expect(path).toBe(join(root, "bin", tool.sha256.slice(0, 16), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
    expect(await Bun.file(path).text()).toBe("#!/bin/sh\necho ffmpeg version 9.0.2\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  test("replaces a copy whose contents no longer match, and sweeps older versions", async () => {
    const tool = await embedded("the real thing");
    const bin = join(root, "bin");
    await mkdir(join(bin, "0123456789abcdef"), { recursive: true });
    const path = await FfmpegLocator.unpack("ffmpeg", tool, bin);

    // Someone swaps the file for something else
    await writeFile(path, "something else");
    await FfmpegLocator.unpack("ffmpeg", tool, bin);

    expect(await Bun.file(path).text()).toBe("the real thing");
    expect(await readdir(bin)).toEqual([tool.sha256.slice(0, 16)]);
  });

  test("refuses an embedded file that doesn't match its recorded hash, and writes nothing", async () => {
    const tool = await embedded("tampered");
    const bin = join(root, "bin");
    await expect(FfmpegLocator.unpack("ffmpeg", { file: tool.file, sha256: "0".repeat(64) }, bin)).rejects.toThrow("does not match");
    expect(existsSync(join(bin, "0".repeat(16), "ffmpeg"))).toBe(false);
  });

  test("finds the system's ffmpeg and ffprobe when nothing else is set", async () => {
    const statuses = await FfmpegLocator.resolve(true);
    for (const status of statuses) {
      const onPath = Bun.which(status.name);
      expect(status.path).toBe(onPath);
      expect(status.source).toBe(onPath ? "path" : null);
      if (onPath) expect(status.version).toBeTruthy();
    }
  });
});
