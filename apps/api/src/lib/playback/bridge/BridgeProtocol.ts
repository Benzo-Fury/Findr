/**
 * What the server and a cast bridge say to each other over the bridge's
 * WebSocket, as JSON text frames. The bridge opens with `hello`; from then
 * on the server asks it to `search` its network or send an `http` request to
 * a TV it found, and the bridge answers each with a `reply` carrying the
 * same id. Both ends check what they receive against these schemas.
 */

import { z } from "zod";

/** Bumped when either side can no longer understand the other. */
export const BRIDGE_PROTOCOL = 1;

/** Where a bridge connects on the server. */
export const BRIDGE_CONNECT_PATH = "/api/playback/bridges/connect";

/** The largest body either side passes on: renderers' descriptions and SOAP answers are a few kilobytes. */
export const MAX_BODY_BYTES = 512 * 1024;

/** The longest a renderer request may be given to answer. */
export const MAX_REQUEST_TIMEOUT_MS = 30_000;

// ---------- Server to bridge ---------- //

/** A request for a TV, as the server sends it; the bridge decides whether it may be sent. */
export const HttpExchangeSchema = z.object({
  url: z.string().max(2048),
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string().max(64), z.string().max(512)),
  body: z.string().max(MAX_BODY_BYTES).nullable(),
  timeoutMs: z.number().int().positive().max(MAX_REQUEST_TIMEOUT_MS),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("search"), id: z.string().max(64) }),
  z.object({ type: z.literal("http"), id: z.string().max(64), exchange: HttpExchangeSchema }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------- Bridge to server ---------- //

export const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int(),
    version: z.string().max(40),
    /** The base URL its TVs fetch media from, its own media proxy; null when it has no address on its network. */
    mediaBase: z.string().max(200).regex(/^https?:\/\/[^\s/]+$/).nullable(),
  }),
  /** `result` when it went well, else `error` saying why not. */
  z.object({ type: z.literal("reply"), id: z.string().max(64), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(500).optional() }),
  /** Keeps the connection, and any proxy in front of the server, from idling out. */
  z.object({ type: z.literal("ping") }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/** What a `search` reply carries: the description URLs found. */
export const SearchResultSchema = z.array(z.string().max(2048)).max(256);

/** What an `http` reply carries: the TV's answer. */
export const HttpResultSchema = z.object({ status: z.number().int(), body: z.string().max(MAX_BODY_BYTES) });
