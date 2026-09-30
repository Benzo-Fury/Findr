import { betterAuth } from "better-auth"
import { database } from "../db/client"

/**
 * BetterAuth instance. Handed the raw `bun:sqlite` connection, which BetterAuth
 * drives through its bundled Kysely dialect — it owns the `user`, `session`,
 * `account` and `verification` tables, including serialising its own dates and
 * booleans, so nothing in the application layer touches them.
 */
export const auth = betterAuth({
  basePath: "/api/auth",
  database,
  emailAndPassword: {
    enabled: true,
  },
  baseURL: process.env.BASE_URL,
  trustedOrigins: process.env.NODE_ENV === "development"
    ? ["http://localhost:5173"]
    : [],
})

/**
 * Creates any of BetterAuth's tables that are missing. Its schema is derived
 * from the options above rather than declared anywhere in this repo, so
 * enabling a plugin or upgrading BetterAuth adds the tables and columns it
 * needs on the next boot.
 *
 * Diffs against the live database and only issues what is absent, so it is
 * safe to call on every startup — an up-to-date database costs roughly a
 * millisecond and existing rows are untouched. Must finish before the server
 * handles its first request.
 */
export async function migrateAuth(): Promise<void> {
  const context = await auth.$context
  await context.runMigrations()
}
