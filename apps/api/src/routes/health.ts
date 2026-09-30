/**
 * Lightweight health-check endpoint. Returns a static JSON payload so load
 * balancers, uptime monitors, and deployment pipelines can verify the API is
 * running without hitting any downstream dependencies.
 */

import { factory } from "../lib/routing/factory"

export default factory({
  authenticated: false,
  rateLimit: { max: 120, window: 60 },
  GET: (c) => c.json({ status: "ok" }),
})
