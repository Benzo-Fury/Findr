/**
 * Read-only lookups of BetterAuth's `user` table, for showing who is doing
 * something. Accounts themselves are created and changed through BetterAuth.
 */

import { Model } from "./Model";

/** The name and email of an account. */
export interface UserName {
  id: string;
  name: string;
  email: string;
}

export class UserAccount extends Model {
  /** Names and emails for a set of user ids; unknown ids are left out. */
  public static names(ids: string[]): Map<string, UserName> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db.query<UserName, string[]>(`SELECT id, name, email FROM user WHERE id IN (${placeholders})`).all(...unique);
    return new Map(rows.map((row) => [row.id, row]));
  }
}
