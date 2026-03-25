import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { db } from "../db"

export const auth = betterAuth({
  basePath: "/api/auth",
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
  },
  baseURL: process.env.BASE_URL,
  trustedOrigins: process.env.NODE_ENV === "development"
    ? ["http://localhost:5173"]
    : [],
})
