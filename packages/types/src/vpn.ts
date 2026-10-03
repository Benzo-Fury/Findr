import { z } from "zod";

/**
 * What the VPN killswitch last concluded, for `/api/vpn`. The killswitch
 * itself is configured in the `vpn` settings section.
 */

/**
 * `off` — the killswitch is disabled and torrents run freely.
 * `up` — every configured check passed; torrents may run.
 * `down` — a check failed or has not passed yet; no torrent traffic is allowed.
 */
export const VpnStateSchema = z.enum(["off", "up", "down"]);
export type VpnState = z.infer<typeof VpnStateSchema>;

/** The outcome of the latest VPN check. */
export interface VpnStatus {
  state: VpnState;
  /** Why the VPN counts as down. Null unless `state` is `down`. */
  reason: string | null;
  /** The interface that matched, and its addresses, when the interface check found one. */
  interfaceName: string | null;
  addresses: string[];
  /** The public address the last lookup saw, when the home IP check is on. */
  publicIp: string | null;
  /** When the check ran, in epoch milliseconds. Null before the first check. */
  checkedAt: number | null;
}
