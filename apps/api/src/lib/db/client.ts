/**
 * Drizzle database client. Connects to Postgres using the `DATABASE_URL`
 * environment variable and exports a ready-to-use query interface.
 */

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as auth from "./schema/auth"
import * as jobs from "./schema/jobs"
import * as indexes from "./schema/indexes"

const schema = { ...auth, ...jobs, ...indexes }

const connection = postgres(process.env.DATABASE_URL!)

export const db = drizzle(connection, { schema })
