import { eq, and } from "drizzle-orm";
import { factory } from "../../../lib/routing/factory";
import { db } from "../../../lib/db";
import { indexes } from "../../../lib/db/schema/indexes";

export default factory({
  authenticated: true,
  middleware: [],
  DELETE: async (ctx) => {
    const session = ctx.get("session") as { user: { id: string } };
    const indexId = ctx.req.param("id") as string;

    const index = await db.query.indexes.findFirst({
      where: and(eq(indexes.id, indexId), eq(indexes.userId, session.user.id)),
    });

    if (!index) {
      return ctx.json({ error: "not_found" }, 404);
    }

    await db.delete(indexes).where(eq(indexes.id, indexId));

    return ctx.body(null, 204);
  },
});
