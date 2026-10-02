import { z } from "zod";

/**
 * Account credentials. A fresh install has a single admin that signs in as
 * `admin` / `admin` and must replace both before doing anything else.
 */

/** Shortest password any account may set. The server's auth config uses the same value. */
export const MIN_PASSWORD_LENGTH = 8;

/** Longest password accepted; anything longer is almost certainly a mistake. */
export const MAX_PASSWORD_LENGTH = 128;

/** What `POST /api/account/credentials` takes: the email and password that replace the initial ones. */
export const CredentialsResetSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
export type CredentialsReset = z.infer<typeof CredentialsResetSchema>;
