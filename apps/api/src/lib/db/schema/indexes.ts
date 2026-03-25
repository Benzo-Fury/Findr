import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  foreignKey,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * A scored torrent result belonging to an index. Stores all metadata
 * needed to download and identify the torrent, plus the computed
 * score used for ranking.
 */
export const torrents = pgTable("torrents", {
  id: uuid("id").primaryKey().defaultRandom(),
  indexId: uuid("index_id").notNull().references((): AnyPgColumn => indexes.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  magnetLink: text("magnet_link").notNull(),
  sizeMB: integer("size_mb").notNull(),
  seeders: integer("seeders").notNull(),
  leechers: integer("leechers").notNull(),
  resolution: text("resolution"),
  videoCodec: text("video_codec"),
  audioCodec: text("audio_codec"),
  hdrFormat: text("hdr_format"),
  releaseType: text("release_type"),
  uploaderName: text("uploader_name"),
  score: real("score").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * An indexed piece of content. Created when a job successfully finds
 * and scores torrents for a movie or series. Points to the chosen
 * source (highest scoring torrent) but the user can switch to any
 * other torrent belonging to this index.
 */
export const indexes = pgTable("indexes", (t) => ({
  id: t.uuid("id").primaryKey().defaultRandom(),
  imdbId: t.text("imdb_id").notNull(),
  season: t.integer("season"),
  sourceId: t.uuid("source_id"),
  userId: t.text("user_id").notNull().references(() => user.id),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
}), (table) => [
  foreignKey({ columns: [table.sourceId], foreignColumns: [torrents.id as AnyPgColumn] }),
  uniqueIndex("indexes_imdb_season_idx").on(table.imdbId, table.season),
]);
