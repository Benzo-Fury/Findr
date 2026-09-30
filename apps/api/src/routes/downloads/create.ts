/**
 * Kicks off a download for a title. The route resolves candidate releases
 * through Prowlarr; scoring, grabbing, and post-processing happen downstream
 * in the pipeline.
 */

import { factory } from "../../lib/routing/factory";
import Prowlarr, { ProwlarrError, type TitleQuery } from "../../lib/prowlarr/Prowlarr";
import z from "zod";

const downloadSchema = z.object({
    title: z.object({
        name: z.string(),
        year: z.number().positive().max(3000), // Programmatically limited 0-3000
        season: z.number().positive().optional(),
        imdbId: z.string(),
        type: z.enum(["movie", "series"])
    }),
});

export default factory({
    authenticated: true,
    POST: {
        handler: async (ctx) => {
            const { title } = ctx.get("body") as z.infer<typeof downloadSchema>;

            // Query Prowlarr for the title — the body shape is already a TitleQuery
            let torrents;
            try {
                torrents = await Prowlarr.getInstance().search(title);
            } catch (error) {
                console.error("[Prowlarr] Search failed:", error);
                const status = error instanceof ProwlarrError ? 502 : 500;
                return ctx.json({ error: "search_failed" }, status);
            }

            if (torrents.length === 0) {
                return ctx.json({ error: "no_releases_found" }, 404);
            }

            return ctx.json({ torrents }, 200);


// - AI omits any irrelevant titles OR chooses only relevant ones (optional)
// - Run built in scoring on results
// - Select highest score
// - Download file from BitTorrent to tmp dir
// - Loop over downloaded files and strip audio and video streams from video formats using mkvmerge
// - Copy new files to output dir.
// - Remove tmp dir


        },

        body: downloadSchema,
    }
})
