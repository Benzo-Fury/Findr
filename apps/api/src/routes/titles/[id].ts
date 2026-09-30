import { z } from "zod"
import { factory } from "../../lib/routing/factory"

const GetTitleSchema = z.object({
    preferences: z.object({
        resolution: z.enum(["720p", "1080p", "2160p"]).optional(),
    }).optional(),
})

export default factory({
    authenticated: true,
    GET: {
        handler: (c) => {
            const { id } = c.req.param()
            const body = c.get("body")
            return c.json({ id, body })
        },
        body: GetTitleSchema,
    },
})