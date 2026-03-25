import { EzTv, YTS, type Torrent } from "@findr/adapters";
import type { Stage } from "../../other/Pipeline";
import type { JoblineCtx } from "../../../types/Jobline";

const movieAdapters = [new YTS()];
const seriesAdapters = [new EzTv()];

/**
 * Determines the correct adapters for the media type, queries them in
 * parallel, and forwards the merged raw torrent list to the next stage.
 */
const query: Stage<JoblineCtx> = {
  status: "querying",
  callback: async (ctx) => {
    const { job, log } = ctx;

    const isSeries = job.season != null;
    const mediaType = isSeries ? "series" : "movie";
    const adapters = isSeries ? seriesAdapters : movieAdapters;

    await log(`[query] Starting — imdbId=${job.imdbId} season=${job.season ?? "n/a"} (${mediaType})`);
    await log(`[query] Querying ${adapters.length} adapter(s)`);

    const settled = await Promise.allSettled(
      adapters.map((a) => a.search({ imdbId: job.imdbId, season: job.season ?? undefined })),
    );

    const torrents = settled.flatMap((r, i) => {
      if (r.status === "fulfilled") {
        log(`[query] ${adapters[i].constructor.name} returned ${r.value.length} result(s)`);
        return r.value;
      }
      log(`[query] ${adapters[i].constructor.name} failed: ${r.reason}`, "error");
      return [] as Torrent[];
    });

    await log(`[query] Complete — ${torrents.length} total result(s) across all adapters`);

    return { torrents };
  },
};

export default query;
