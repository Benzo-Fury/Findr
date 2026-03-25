import { resolve, dirname } from "path";
import Adapter, { type AdapterSearchParams, type Torrent } from "../types/Adapter";
import { parseTorrentTitle } from "../lib/parseTorrentTitle";

interface ScraperResult {
  imdb_id: string;
  name: string;
  magnet_uri: string;
  seeds: number | null;
  season?: number;
}

/**
 * Adapter for TheRARBG (movies and TV).
 *
 * No public API — shells out to the therarbg-cli Rust binary.
 * Supports passing season via the --episodes flag; year is filtered locally.
 */
export default class TheRARBG extends Adapter {
  async search(ops: AdapterSearchParams): Promise<[Torrent]> {
    const raw = await this.exec(ops);
    const filtered = this.filter(raw, ops);

    return filtered
      .sort((a, b) => b.seeders - a.seeders)
      .slice(0, 5) as [Torrent];
  }

  private async exec(ops: AdapterSearchParams): Promise<ScraperResult[]> {
    const binary = this.findBinary();
    const args = this.buildArgs(ops);

    const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => proc.kill(), TheRARBG.timeout);

    let stdout: string;
    let stderr: string;
    let code: number;

    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      code = await proc.exited;
    } finally {
      clearTimeout(kill);
    }

    if (code !== 0) {
      const reason = proc.killed ? "timed out" : `exited ${code}`;
      throw new Error(`therarbg-cli ${reason}: ${stderr.trim()}`);
    }

    return JSON.parse(stdout) as ScraperResult[];
  }

  private filter(results: ScraperResult[], ops: AdapterSearchParams): Torrent[] {
    const torrents: Torrent[] = [];

    for (const r of results) {
      if (ops.season !== undefined && r.season !== undefined && r.season !== ops.season) continue;

      const parsed = parseTorrentTitle(r.name);
      torrents.push({
        title: r.name,
        season: r.season,
        ...parsed,
        magnetLink: r.magnet_uri,
        sizeMB: 0,
        seeders: r.seeds ?? 0,
        leechers: 0,
        uploaderName: parsed.releaseGroup,
      });
    }

    return torrents;
  }

  private buildArgs(ops: AdapterSearchParams): string[] {
    const args = ["--imdb", ops.imdbId];
    if (ops.season !== undefined) {
      args.push("--episodes", `S${String(ops.season).padStart(2, "0")}`);
    }
    return args;
  }

  /**
   * In production the binary sits alongside the bundled JS in `dist/`.
   * In development it's resolved relative to the monorepo root under
   * the Rust build output directories.
   */
  private findBinary(): string {
    if (process.env.NODE_ENV === "production") {
      return resolve(dirname(Bun.main), "therarbg-cli");
    }

    const root = resolve(dirname(Bun.main), "../../..");
    return resolve(root, "rust/therarbg-cli/target/release/therarbg-cli");
  }
}
