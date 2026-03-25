import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { QBittorrent } from "@ctrl/qbittorrent";
import config from "../../../config.json";
import type { Stage } from "../../other/Pipeline";
import { resolveEncoderArgs } from "../../other/Encoders";
import type { JoblineCtx } from "../../../types/Jobline";

const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv",
  ".m4v", ".ts", ".m2ts", ".webm", ".vob", ".mpg", ".mpeg",
]);

const DONE_STATES  = new Set(["uploading", "stalledUP", "pausedUP", "forcedUP", "queuedUP"]);
const ERROR_STATES = new Set(["error", "missingFiles", "unknown"]);
const POLL_MS      = 10_000;
const TIMEOUT_MS   = 60 * 60 * 1000;

async function findVideos(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findVideos(full));
    } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}


/**
 * Downloads the top-ranked torrent via qBittorrent, transcodes every video
 * file through ffmpeg (stripping metadata and re-encoding to H.264/AAC), and
 * writes the clean output to a job-specific directory on the host.
 *
 * Automatically probes for the best available hardware encoder (VideoToolbox,
 * NVENC, QSV, VAAPI, AMF) and falls back to libx264 software encoding. This
 * behaviour can be overridden via `config.ffmpeg`.
 */
const sterilize: Stage<JoblineCtx> = {
  status: "sterilizing",
  callback: async (ctx) => {
    const job = ctx.job as any;
    const log = ctx.log as (msg: string, level?: string) => Promise<void>;

    const topTorrent = ctx.topTorrent;
    if (!topTorrent) {
      await log(`[sterilize] No top torrent in context`, "error");
      throw new Error("No torrent to sterilize");
    }

    const top = { torrent: topTorrent, score: topTorrent.score };

    const downloadDir = join(config.paths.download, job.id);
    const outputDir   = join(config.paths.download, `${job.id}_output`);

    await log(`[sterilize] Starting — top torrent: "${top.torrent.title}" (score: ${top.score.toFixed(2)})`);
    await log(`[sterilize] Download dir: ${downloadDir}`);
    await log(`[sterilize] Output dir: ${outputDir}`);

    await mkdir(downloadDir, { recursive: true });
    await mkdir(outputDir,   { recursive: true });

    // ── qBittorrent ──────────────────────────────────────────────────────

    const qbt = new QBittorrent({
      baseUrl:  `http://localhost:${process.env.QBT_PORT ?? "8080"}`,
      username: process.env.QBT_USERNAME ?? "",
      password: process.env.QBT_PASSWORD ?? "",
    });

    // Parse info hash from magnet xt= param (urn:btih:<hash>)
    const xt = new URL(top.torrent.magnetLink.replace("magnet:", "magnet://x")).searchParams.get("xt") ?? "";
    const infoHash = xt.split(":").at(-1)?.toLowerCase() ?? "";
    if (!infoHash) throw new Error("Could not parse info hash from magnet link");

    // ── Resume-aware download ────────────────────────────────────────────

    let skipDownload = false;
    const existing = await qbt.listTorrents({ hashes: infoHash });
    const existingTorrent = existing[0];

    if (existingTorrent) {
      const state = existingTorrent.state as string;

      if (DONE_STATES.has(state)) {
        await log(`[sterilize] Torrent already complete in qBittorrent, skipping download`);
        skipDownload = true;
      } else if (ERROR_STATES.has(state)) {
        await log(`[sterilize] Torrent in error state (${state}), removing and re-adding`);
        await qbt.removeTorrent(infoHash, false).catch(() => {});
      } else {
        await log(`[sterilize] Resuming in-progress download — state: ${state}`);
      }
    } else {
      const existingVideos = await findVideos(downloadDir).catch(() => []);

      if (existingVideos.length > 0) {
        await log(`[sterilize] Download dir has ${existingVideos.length} existing video file(s), skipping download`);
        skipDownload = true;
      } else {
        await log(`[sterilize] Adding torrent to qBittorrent — hash: ${infoHash}`);
        await qbt.addMagnet(top.torrent.magnetLink, { savepath: downloadDir });
      }
    }

    if (!skipDownload) {
      const deadline = Date.now() + TIMEOUT_MS;
      await log(`[sterilize] Polling every ${POLL_MS / 1000}s until download completes...`);

      while (true) {
        if (Date.now() > deadline) {
          await qbt.removeTorrent(infoHash, false).catch(() => {});
          throw new Error("Download exceeded 1hr timeout");
        }

        const torrents = await qbt.listTorrents({ hashes: infoHash });
        const torrent  = torrents[0];

        if (!torrent) throw new Error("Torrent disappeared from qBittorrent");

        const state    = torrent.state as string;
        const progress = ((torrent.progress ?? 0) * 100).toFixed(1);

        if (DONE_STATES.has(state)) {
          await log(`[sterilize] Download complete — state: ${state}`);
          break;
        }
        if (ERROR_STATES.has(state)) {
          await qbt.removeTorrent(infoHash, false).catch(() => {});
          throw new Error(`qBittorrent reported error state: ${state}`);
        }

        const eta = torrent.eta && torrent.eta < 8_640_000 ? `, ETA: ${torrent.eta}s` : "";
        await log(`[sterilize] Downloading — state: ${state}, progress: ${progress}%${eta}`);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }

    // ── Find video files ─────────────────────────────────────────────────

    const videoFiles = await findVideos(downloadDir);
    await log(`[sterilize] Found ${videoFiles.length} video file(s) to transcode`);
    if (videoFiles.length === 0) {
      await qbt.removeTorrent(infoHash, false).catch(() => {});
      throw new Error("No video files found in download directory");
    }

    // ── Transcode ────────────────────────────────────────────────────────

    const encoder = await resolveEncoderArgs();
    const isHardware = encoder.name !== "libx264";
    await log(`[sterilize] Video encoder: ${encoder.name} (${isHardware ? "hardware" : "software"})`);

    try {
      for (let i = 0; i < videoFiles.length; i++) {
        const src  = videoFiles[i];
        const name = src.split("/").at(-1)!.replace(/\.[^.]+$/, "") + ".mp4";
        const dst  = join(outputDir, name);

        // If a previous encode exists, delete it and re-encode from scratch
        const exists = await stat(dst).then(() => true, () => false);
        if (exists) {
          await log(`[sterilize] Removing previous output, will re-encode: ${name}`);
          await rm(dst, { force: true });
        }

        await log(`[sterilize] Transcoding ${i + 1}/${videoFiles.length}: ${src.split("/").at(-1)} → ${name}`);

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(config.paths.ffmpeg, [
            "-i",            src,
            "-map",          "0:v:0",
            "-map",          "0:a",
            "-map_metadata", "-1",
            "-map_chapters", "-1",
            ...encoder.args,
            "-c:a",          "aac",
            dst,
          ]);

          proc.stderr?.on("data", (data: Buffer) => {
            log(`[sterilize:ffmpeg] ${data.toString().trimEnd()}`);
          });

          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
          });
        });

        await log(`[sterilize] Transcoded: ${src.split("/").at(-1)} → ${name}`);
      }

      await rm(downloadDir, { recursive: true, force: true });
      await log(`[sterilize] Deleted download dir: ${downloadDir}`);
    } finally {
      await qbt.removeTorrent(infoHash, false).catch(() => {});
      await log(`[sterilize] Torrent removed from qBittorrent`);
    }

    await log(`[sterilize] Done — sterilized files at ${outputDir}`);
    return { outputDir };
  },
};

export default sterilize;
