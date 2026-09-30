/**
 * Translates the download queue's refusals into HTTP responses, so every
 * route reports them with the same codes and statuses.
 */

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { QueueError } from "../pipeline/DownloadQueue"

const STATUS: Record<QueueError["code"], ContentfulStatusCode> = {
  not_found: 404,
  candidate_not_found: 404,
  already_downloading: 409,
  not_finished: 409,
}

/** Runs a queue command, answering with the error's code if the queue refuses. Other errors propagate. */
export async function withQueue(c: Context, command: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await command()
  } catch (error) {
    if (error instanceof QueueError) return c.json({ error: error.code }, STATUS[error.code])
    throw error
  }
}
