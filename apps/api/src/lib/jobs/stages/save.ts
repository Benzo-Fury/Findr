import { rename, mkdir, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import config from "../../../config.json";
import type { Stage } from "../../other/Pipeline";
import type { JoblineCtx } from "../../../types/Jobline";

const TMDB_BASE = "https://api.themoviedb.org/3";

interface TMDBMeta {
  title: string;
  year: string;
}

/** Fetches the clean title and release year for an IMDb ID via TMDB's /find endpoint. */
async function fetchTMDBMeta(imdbId: string): Promise<TMDBMeta | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;

  const res = await fetch(`${TMDB_BASE}/find/${imdbId}?external_source=imdb_id&api_key=${key}`);
  const data = (await res.json()) as any;

  const movie = data.movie_results?.[0];
  const tv = data.tv_results?.[0];
  const item = movie ?? tv;
  if (!item) return null;

  return {
    title: movie ? item.title : item.name,
    year: (movie ? item.release_date : item.first_air_date)?.slice(0, 4) ?? "",
  };
}

/** Replaces `{token}` placeholders in a naming template with the provided values. */
function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

/** Sanitises a string for use as a filename — removes characters that are illegal or
 * problematic across macOS, Linux, and Windows filesystems. */
function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, "").trim();
}

const EPISODE_PATTERN = /[Ss](\d{1,2})\s*[Ee](\d{1,3})/;

/** Attempts to extract a season and episode number from a torrent-style filename. */
function parseEpisode(filename: string): { season: string; episode: string } | null {
  const match = filename.match(EPISODE_PATTERN);
  if (!match) return null;
  return {
    season: match[1].padStart(2, "0"),
    episode: match[2].padStart(2, "0"),
  };
}

/**
 * Moves the sterilized output files from the temporary encode directory into
 * the final library path, applying the naming templates from `config.naming`.
 *
 * Uses `rename()` which maps to a `mv` syscall — an instant metadata-only
 * operation when source and destination live on the same filesystem. Falls back
 * to a Bun-native copy + delete when crossing filesystem boundaries.
 */
const save: Stage<JoblineCtx> = {
  status: "saving",
  callback: async (ctx) => {
    const job = ctx.job as any;
    const log = ctx.log as (msg: string, level?: string) => Promise<void>;

    const outputDir = ctx.outputDir;
    if (!outputDir) {
      await log(`[save] No outputDir in context`, "error");
      throw new Error("No output directory to save from");
    }

    const isSeries = job.season != null;

    const files = await readdir(outputDir);
    if (files.length === 0) {
      await log(`[save] Output directory is empty, nothing to move`, "error");
      throw new Error("Output directory contains no files");
    }

    // ── Resolve TMDB metadata for naming ──────────────────────────────────

    const meta = await fetchTMDBMeta(job.imdbId);
    if (!meta) {
      await log(`[save] Could not fetch TMDB metadata for ${job.imdbId} — files will keep original names`, "warn");
    }

    // ── Build destination path ────────────────────────────────────────────

    let destDir: string;

    if (isSeries) {
      const values = meta ? { title: meta.title, year: meta.year } : null;
      const showFolder = values
        ? sanitize(applyTemplate(config.naming.seriesFolder, values))
        : job.imdbId;
      const seasonFolder = values
        ? sanitize(applyTemplate(config.naming.seasonFolder, { season: String(job.season).padStart(2, "0") }))
        : `Season ${String(job.season).padStart(2, "0")}`;
      destDir = join(config.paths.series, showFolder, seasonFolder);
    } else {
      const folderName = meta
        ? sanitize(applyTemplate(config.naming.movieFolder, { title: meta.title, year: meta.year }))
        : job.imdbId;
      destDir = join(config.paths.movies, folderName);
    }

    await mkdir(destDir, { recursive: true });
    await log(`[save] Destination: ${destDir}`);
    await log(`[save] Moving ${files.length} file(s)`);

    // ── Move files ────────────────────────────────────────────────────────

    for (const file of files) {
      const src = join(outputDir, file);
      const ext = extname(file);

      let destName: string;

      if (isSeries && meta) {
        const ep = parseEpisode(file);
        const season = ep?.season ?? String(job.season).padStart(2, "0");
        const episode = ep?.episode ?? "";
        destName = sanitize(applyTemplate(config.naming.seriesFile, {
          title: meta.title,
          year: meta.year,
          season,
          episode,
        })) + ext;
      } else if (!isSeries && meta) {
        destName = sanitize(applyTemplate(config.naming.movieFile, {
          title: meta.title,
          year: meta.year,
        })) + ext;
      } else {
        destName = file;
      }

      const dst = join(destDir, destName);

      try {
        await rename(src, dst);
        await log(`[save] Moved: ${file} → ${destName}`);
      } catch (err: any) {
        // EXDEV means source and dest are on different filesystems — rename can't
        // cross mount boundaries, so fall back to a Bun-native copy + delete.
        if (err.code === "EXDEV") {
          await log(`[save] Cross-device move, falling back to copy: ${file}`);
          await Bun.write(dst, Bun.file(src));
          await rm(src, { force: true });
          await log(`[save] Copied and removed original: ${file} → ${destName}`);
        } else {
          throw err;
        }
      }
    }

    await rm(outputDir, { recursive: true, force: true });
    await log(`[save] Cleaned up output directory`);
    await log(`[save] Done — ${files.length} file(s) saved to ${destDir}`);
  },
};

export default save;
