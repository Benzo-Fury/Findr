/**
 * Finds the ffmpeg and ffprobe binaries everything else runs: the sterilizer
 * on every download, and playback on every library file.
 *
 * Each is looked for in order: the path in the environment (`FFMPEG_PATH`,
 * `FFPROBE_PATH`), then the copy embedded in a compiled executable, then the
 * one on `PATH`. A candidate counts only once it answers `-version`. The
 * embedded copy is written out beside the database the first time it is
 * chosen, under a folder named by its hash, and checked against that hash on
 * every start, so a damaged or swapped file is replaced rather than run.
 *
 * The paths never come from a setting: an executable path editable from the
 * browser would let a hijacked admin session run any program on the server.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolName, ToolStatus } from "@findr/types/setup";
import { client } from "../db/client";
import { env } from "../env/Env";

/** One binary embedded in a compiled executable: the gzipped file and the hash of the binary inside. */
export interface EmbeddedTool {
  file: string;
  sha256: string;
}

/** How long a candidate may take to answer `-version`. */
const VERSION_TIMEOUT_MS = 10_000;

/** Characters of the hash that name an extracted binary's folder. */
const HASH_PREFIX = 16;

/** Every binary the locator finds. */
const TOOLS: readonly ToolName[] = ["ffmpeg", "ffprobe"];

export class FfmpegLocator {
  /** What each binary resolved to, once resolved. */
  private static resolved = new Map<ToolName, ToolStatus>();
  /** The resolution in flight, shared by concurrent callers. */
  private static resolving: Promise<ToolStatus[]> | null = null;

  /**
   * The path to run a binary from. Before `resolve()` has finished, or when
   * it found nothing, this is the bare name, so a spawn still tries `PATH`
   * and fails the usual way when the binary is missing.
   */
  public static path(name: ToolName): string {
    return this.resolved.get(name)?.path ?? env[this.envKey(name)] ?? name;
  }

  /** Whether both binaries were found. */
  public static async available(): Promise<boolean> {
    const statuses = await this.resolve();
    return statuses.every((status) => status.path !== null);
  }

  /**
   * Finds both binaries, once per process unless `refresh` is set. Safe to
   * call from many places at once.
   */
  public static async resolve(refresh = false): Promise<ToolStatus[]> {
    if (refresh) {
      this.resolved.clear();
      this.resolving = null;
    }
    if (this.resolved.size === TOOLS.length) return TOOLS.map((name) => this.resolved.get(name)!);

    this.resolving ??= (async () => {
      const embedded = await this.embedded();
      const statuses = await Promise.all(TOOLS.map((name) => this.locate(name, embedded[name])));
      for (const status of statuses) this.resolved.set(status.name, status);
      return statuses;
    })().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  // ---------- Candidates ---------- //

  /** Tries each place a binary can come from, in order. */
  private static async locate(name: ToolName, embedded: EmbeddedTool | undefined): Promise<ToolStatus> {
    // A path set in the environment is the deployment's explicit choice
    const configured = env[this.envKey(name)];
    if (configured) {
      const version = await this.version(configured);
      if (version) return { name, path: configured, version, source: "env" };
      console.warn(`[Tools] ${this.envKey(name)} is set to "${configured}", which does not run; looking elsewhere`);
    }

    // The copy shipped inside this executable
    if (embedded) {
      try {
        const path = client.directory ? await this.unpack(name, embedded, join(client.directory, "bin")) : null;
        const version = path ? await this.version(path) : null;
        if (path && version) return { name, path, version, source: "embedded" };
      } catch (error) {
        console.warn(`[Tools] Could not unpack the bundled ${name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    // Whatever is installed on the system
    const onPath = Bun.which(name);
    if (onPath) {
      const version = await this.version(onPath);
      if (version) return { name, path: onPath, version, source: "path" };
    }

    console.warn(`[Tools] ${name} was not found; downloads can't be cleaned and nothing can be played until it is installed`);
    return { name, path: null, version: null, source: null };
  }

  /** The version a binary reports, or null when it doesn't run. */
  private static async version(path: string): Promise<string | null> {
    try {
      const child = Bun.spawn([path, "-hide_banner", "-version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS);
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      clearTimeout(timer);
      if (exitCode !== 0) return null;

      // The first line reads like `ffmpeg version 9.0 Copyright (c) 2000-2026 …`
      return /version\s+(\S+)/.exec(stdout)?.[1] ?? "unknown";
    } catch {
      return null;
    }
  }

  // ---------- Embedded copies ---------- //

  /** The binaries this executable carries; none when running from source. */
  private static async embedded(): Promise<Partial<Record<ToolName, EmbeddedTool>>> {
    try {
      const { tools } = await import("../../_tools.map");
      return tools;
    } catch {
      return {};
    }
  }

  /**
   * Writes an embedded binary out under `root` (`bin/` beside the database),
   * or reuses the copy already there when its hash still matches, and
   * returns its path.
   */
  public static async unpack(name: ToolName, tool: EmbeddedTool, root: string): Promise<string> {
    const directory = join(root, tool.sha256.slice(0, HASH_PREFIX));
    const path = join(directory, process.platform === "win32" ? `${name}.exe` : name);

    // A copy that is still intact is used as it is
    if (existsSync(path) && this.sha256(readFileSync(path)) === tool.sha256) return path;

    // Unpack, check the hash before the file is ever runnable, then move it into place whole
    const binary = Bun.gunzipSync(await Bun.file(tool.file).bytes());
    if (this.sha256(binary) !== tool.sha256) throw new Error(`the bundled ${name} does not match its recorded hash`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, binary, { mode: 0o600 });
    await chmod(temporary, 0o700);
    await rename(temporary, path);

    // Folders left by earlier versions go, unless another binary of this version lives there
    await this.sweep(root, directory);
    console.log(`[Tools] Unpacked the bundled ${name} to ${path}`);
    return path;
  }

  /** Deletes extracted folders other than `keep`. */
  private static async sweep(root: string, keep: string): Promise<void> {
    const embedded = await this.embedded();
    const current = new Set(Object.values(embedded).map((tool) => join(root, tool.sha256.slice(0, HASH_PREFIX))));
    current.add(keep);
    for (const entry of await readdir(root).catch(() => [] as string[])) {
      const path = join(root, entry);
      if (!current.has(path)) await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Hex SHA-256 of some bytes. */
  private static sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** The environment variable naming a binary. */
  private static envKey(name: ToolName): "FFMPEG_PATH" | "FFPROBE_PATH" {
    return name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  }
}
