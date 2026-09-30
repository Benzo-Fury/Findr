/**
 * Shared plumbing for every model. Models are the only code that talks SQL:
 * the rest of the application calls their methods and gets back instances or
 * plain records, never rows or statements.
 */

import type { Database } from "bun:sqlite";
import { database } from "../client";

export abstract class Model {
  /** The shared connection every model queries through. */
  protected static get db(): Database {
    return database;
  }

  /** A new random primary key. */
  protected static newId(): string {
    return crypto.randomUUID();
  }

  /**
   * Runs a unit of work atomically. Model calls made inside share one
   * transaction, so a multi-model write either fully lands or not at all.
   */
  public static transaction<T>(work: () => T): T {
    return database.transaction(work)();
  }

  /** Turns a page number and size into a SQL offset. */
  protected static offset(page: number, pageSize: number): number {
    return (page - 1) * pageSize;
  }
}
