import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  imdbId: text("imdb_id").notNull(),
  season: integer("season"),
  status: jsonb("status").$type<{
    primary: "pending" | "querying" | "deciding" | "sterilizing" | "saving" | "completed" | "failed" | "cancelled";
    message?: string;
  }>().notNull().default({ primary: "pending" }),
  preferences: jsonb("preferences"),
  userId: text("user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
