/**
 * A cast bridge an admin has added: Findr run as `findr bridge` on another
 * network, which connects to the server with a token to find and drive the
 * DLNA TVs there. The token is shown once when the bridge is added; only its
 * SHA-256 hash is stored, so the database can't be used to impersonate one.
 */

import { createHash, randomBytes } from "node:crypto";
import type { CastBridgeRecord } from "@findr/types/playback";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `cast_bridges` row as stored. */
interface CastBridgeRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

/** Tokens start with this, so one is recognisable wherever it is pasted. */
const TOKEN_PREFIX = "fcb_";

// ---------- Model ---------- //

export class CastBridge extends Model {
  public readonly id: string;
  public readonly name: string;
  public readonly createdAt: number;
  public lastSeenAt: number | null;

  private constructor(row: CastBridgeRow) {
    super();
    this.id = row.id;
    this.name = row.name;
    this.createdAt = row.created_at;
    this.lastSeenAt = row.last_seen_at;
  }

  /** Adds a bridge, returning it with the token it connects with. */
  public static create(name: string): { bridge: CastBridge; token: string } {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row: CastBridgeRow = { id: this.newId(), name, token_hash: this.hash(token), created_at: Date.now(), last_seen_at: null };
    this.db
      .query("INSERT INTO cast_bridges (id, name, token_hash, created_at, last_seen_at) VALUES ($id, $name, $hash, $createdAt, NULL)")
      .run({ id: row.id, name: row.name, hash: row.token_hash, createdAt: row.created_at });
    return { bridge: new CastBridge(row), token };
  }

  /** Every bridge, oldest first. */
  public static all(): CastBridge[] {
    return this.db
      .query<CastBridgeRow, []>("SELECT * FROM cast_bridges ORDER BY created_at, id")
      .all()
      .map((row) => new CastBridge(row));
  }

  public static find(id: string): CastBridge | null {
    const row = this.db.query<CastBridgeRow, { id: string }>("SELECT * FROM cast_bridges WHERE id = $id").get({ id });
    return row ? new CastBridge(row) : null;
  }

  /** The bridge a token belongs to, or null for a token that isn't one. */
  public static findByToken(token: string): CastBridge | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    // Looked up by hash, so the stored value an attacker could time is never the token itself
    const row = this.db.query<CastBridgeRow, { hash: string }>("SELECT * FROM cast_bridges WHERE token_hash = $hash").get({ hash: this.hash(token) });
    return row ? new CastBridge(row) : null;
  }

  /** As the settings page lists it, with what the server knows of its connection. */
  public toRecord(live: Pick<CastBridgeRecord, "online" | "version" | "address" | "renderers">): CastBridgeRecord {
    return { id: this.id, name: this.name, ...live, lastSeenAt: this.lastSeenAt, createdAt: this.createdAt };
  }

  /** Records that the bridge connected or spoke just now. */
  public touch(now = Date.now()): void {
    this.lastSeenAt = now;
    CastBridge.db.query("UPDATE cast_bridges SET last_seen_at = $now WHERE id = $id").run({ id: this.id, now });
  }

  /** Removes the bridge; its token stops working at once. */
  public delete(): void {
    CastBridge.db.query("DELETE FROM cast_bridges WHERE id = $id").run({ id: this.id });
  }

  /** A token's stored form. */
  private static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
