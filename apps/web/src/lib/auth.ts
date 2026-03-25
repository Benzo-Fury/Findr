import { createAuthClient } from "better-auth/react"

export const auth = createAuthClient({
  baseURL: window.location.origin,
})
