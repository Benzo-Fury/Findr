import {
  codecRank,
  defaultPreferences,
  defaultResolutionRank,
  releaseTypeRank,
  reputableGroups,
  scoringWeights,
} from "@findr/config";
import type { Torrent } from "@findr/adapters";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { indexes, torrents as torrentsTable } from "../../db/schema/indexes";
import type { Stage } from "../../other/Pipeline";
import type { JoblineCtx } from "../../../types/Jobline";

interface Preferences {
  resolutions: string[];
  maxFileSizeGB: number;
  minSeeders: number;
  blacklistedReleaseTypes: string[];
}

function scoreResolution(t: Torrent, prefs: Preferences): number {
  if (!t.resolution) return 0;

  if (prefs.resolutions.length > 0) {
    const idx = prefs.resolutions.indexOf(t.resolution);
    if (idx === -1) return 0;
    return ((prefs.resolutions.length - idx) / prefs.resolutions.length) * scoringWeights.resolution;
  }

  const rank = defaultResolutionRank[t.resolution] ?? 0;
  return (rank / 3) * scoringWeights.resolution;
}

function scoreCodec(t: Torrent): number {
  if (!t.videoCodec) return 0;
  return ((codecRank[t.videoCodec] ?? 0) / 3) * scoringWeights.codec;
}

function scoreSeeders(t: Torrent, minSeeders: number): number {
  if (t.seeders < minSeeders) return -scoringWeights.seeders;
  const capped = Math.min(t.seeders, 1000);
  return (Math.log10(capped + 1) / Math.log10(1001)) * scoringWeights.seeders;
}

function scoreReleaseType(t: Torrent): number {
  if (!t.releaseType) return 0;
  return ((releaseTypeRank[t.releaseType] ?? 0) / 7) * scoringWeights.releaseType;
}

function scoreReleaseGroup(t: Torrent): number {
  if (!t.uploaderName) return 0;
  if (reputableGroups.has(t.uploaderName.toUpperCase())) return scoringWeights.releaseGroup;
  return scoringWeights.releaseGroup * 0.3;
}

function scoreFileSize(t: Torrent): number {
  if (t.sizeMB <= 0) return 0;
  const gb = t.sizeMB / 1024;

  if (gb < 0.5) return -scoringWeights.fileSize * 0.8;
  if (gb > 30) return -scoringWeights.fileSize * 0.6;
  if (gb > 15) return -scoringWeights.fileSize * 0.3;

  const deviation = (gb - 4) / 4;
  return Math.exp(-0.5 * deviation * deviation) * scoringWeights.fileSize;
}

function scoreUploadDate(t: Torrent): number {
  if (!t.uploadedAt) return 0;
  const ageDays = (Date.now() - t.uploadedAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / 365) * scoringWeights.uploadDate;
}

function score(t: Torrent, prefs: Preferences): number {
  let s =
    scoreResolution(t, prefs) +
    scoreCodec(t) +
    scoreSeeders(t, prefs.minSeeders) +
    scoreReleaseType(t) +
    scoreFileSize(t) +
    scoreReleaseGroup(t) +
    scoreUploadDate(t);

  if (t.resolution === "2160p" && t.sizeMB > 20_480) {
    s += scoringWeights.penaltyBloated4K;
  }

  return s;
}

/**
 * Applies user preferences to filter out blacklisted release types, then
 * scores and sorts the remaining torrents. The ranked list is forwarded
 * to the next stage ready for persistence.
 */
const decide: Stage<JoblineCtx> = {
  status: "deciding",
  callback: async (ctx) => {
    const { job, log, torrents: rawTorrents } = ctx;
    const torrents = rawTorrents ?? [];

    const prefs: Preferences = { ...defaultPreferences, ...(job.preferences ?? {}) };

    await log(`[decide] Starting — ${torrents.length} torrent(s) to evaluate`);
    await log(
      `[decide] Preferences — resolutions: [${prefs.resolutions.join(", ")}], minSeeders: ${prefs.minSeeders}, maxFileSizeGB: ${prefs.maxFileSizeGB}, blacklisted: [${prefs.blacklistedReleaseTypes.join(", ")}]`,
    );

    const eligible = torrents.filter(
      (t) => !t.releaseType || !prefs.blacklistedReleaseTypes.includes(t.releaseType),
    );

    await log(
      `[decide] ${torrents.length - eligible.length} torrent(s) removed by blacklist filter — ${eligible.length} remaining`,
    );

    const scoredTorrents = eligible
      .map((t) => ({ torrent: t, score: score(t, prefs) }))
      .sort((a, b) => b.score - a.score);

    if (scoredTorrents.length > 0) {
      const top = scoredTorrents[0];
      await log(
        `[decide] Top torrent: "${top.torrent.title}" — score: ${top.score.toFixed(2)}, seeders: ${top.torrent.seeders}, resolution: ${top.torrent.resolution ?? "unknown"}`,
      );
    } else {
      await log(`[decide] No eligible torrents after scoring`, "warn");
    }

    await log(`[decide] Complete — ${scoredTorrents.length} torrent(s) scored and ranked`);

    // Persist index (without sourceId until we have torrent IDs)
    const [index] = await db
      .insert(indexes)
      .values({ imdbId: job.imdbId, season: job.season, userId: job.userId })
      .returning();

    await log(`[decide] Created index indexId=${index.id}`);

    // Persist all scored torrents
    const insertedTorrents = scoredTorrents.length > 0
      ? await db
          .insert(torrentsTable)
          .values(
            scoredTorrents.map(({ torrent: t, score }) => ({
              indexId: index.id,
              title: t.title,
              magnetLink: t.magnetLink,
              sizeMB: t.sizeMB,
              seeders: t.seeders,
              leechers: t.leechers,
              resolution: t.resolution,
              videoCodec: t.videoCodec,
              audioCodec: t.audioCodec,
              hdrFormat: t.hdrFormat,
              releaseType: t.releaseType,
              uploaderName: t.uploaderName,
              score,
            })),
          )
          .returning()
      : [];

    await log(`[decide] Persisted ${insertedTorrents.length} torrent(s)`);

    // Point index at the top torrent
    const topTorrent = insertedTorrents[0];
    if (topTorrent) {
      await db.update(indexes).set({ sourceId: topTorrent.id }).where(eq(indexes.id, index.id));
      await log(`[decide] Set index sourceId=${topTorrent.id}`);
    }

    return { scoredTorrents, index, topTorrent };
  },
};

export default decide;
