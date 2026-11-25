/**
 * A signed, self-contained request to play something on a Google Cast
 * receiver. The player gets a cast URL with every session but no work is done
 * for it: the receiver's first request turns the ticket into a session of its
 * own, sized for a TV rather than for the browser that issued it.
 */

import { StreamToken } from "./StreamToken";

/** What a ticket asks for, in short keys to keep the URL small. */
export interface CastTicketData {
  /** The user who cast it. */
  userId: string;
  titleId: string;
  season: number | null;
  episode: number | null;
  audioTrack: number | null;
  maxBitrate: number | null;
}

/** The ticket's payload as encoded. */
interface Payload {
  u: string;
  t: string;
  s: number | null;
  e: number | null;
  a: number | null;
  b: number | null;
}

/** How long a cast URL stays valid. */
const LIFETIME_MS = 12 * 60 * 60 * 1000;

export class CastTicket {
  /** A ticket for one movie or episode. */
  public static issue(data: CastTicketData, now = Date.now()): string {
    const payload: Payload = { u: data.userId, t: data.titleId, s: data.season, e: data.episode, a: data.audioTrack, b: data.maxBitrate };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const expires = (now + LIFETIME_MS).toString(36);
    return `${encoded}.${expires}.${StreamToken.signature(`cast:${encoded}.${expires}`)}`;
  }

  /** What a ticket asks for, or null when it is malformed, forged or expired. */
  public static verify(ticket: string, now = Date.now()): CastTicketData | null {
    const [encoded, expires, signature, extra] = ticket.split(".");
    if (!encoded || !expires || !signature || extra !== undefined) return null;
    if (!StreamToken.matches(`cast:${encoded}.${expires}`, signature)) return null;

    const expiresAt = Number.parseInt(expires, 36);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Partial<Payload>;
      if (typeof payload.u !== "string" || typeof payload.t !== "string") return null;
      const number = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
      return {
        userId: payload.u,
        titleId: payload.t,
        season: number(payload.s),
        episode: number(payload.e),
        audioTrack: number(payload.a),
        maxBitrate: number(payload.b),
      };
    } catch {
      return null;
    }
  }
}
