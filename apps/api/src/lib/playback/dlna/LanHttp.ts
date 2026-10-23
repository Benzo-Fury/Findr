/**
 * Sends a renderer request straight over the local network. The server does
 * this for TVs on its own network, and a cast bridge for the TVs on its.
 * Redirects are refused, so a device can never send the request elsewhere.
 */

import type { HttpExchange, HttpReply } from "./RendererNetwork";

export class LanHttp {
  /** Sends the request and reads the whole answer as text. */
  public static async request(exchange: HttpExchange): Promise<HttpReply> {
    const response = await fetch(exchange.url, {
      method: exchange.method,
      headers: exchange.headers,
      body: exchange.body,
      redirect: "error",
      signal: AbortSignal.timeout(exchange.timeoutMs),
    });
    // A body cut off part-way still tells the status
    return { status: response.status, body: await response.text().catch(() => "") };
  }
}
