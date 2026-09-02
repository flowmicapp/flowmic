// SPEC-REF:
//   GA-21 (LAN candidate ordering) — apps/desktop/src-tauri/src/sidecar/network.rs
//   CLAUDE.md red line: no silent failure (a hidden candidate the owner needs)
//
// The `/api/network` candidate family: which of this host's IPv4 addresses a
// phone on the LAN could plausibly dial, and in what order to offer them.
//
// 2026-09-02 — MOVED VERBATIM out of router.ts, which hit the 800-line cap
// (file-size lint). This family has exactly one call site left in router.ts
// (`collectLanCandidates()` building the `/api/network` payload) and one
// consumer test (http-network.test.ts) — a router.ts import/re-export keeps
// both working unchanged. No behaviour changed by this move.

import { networkInterfaces } from 'node:os';

/** How an IPv4 address ranks as a "phone on the same LAN can dial this" guess.
 *  GA-21: the old heuristic was a binary RFC1918 / not-RFC1918 split, which sank
 *  legal-but-non-standard office ranges (owner's `100.64.7.x`) BELOW public
 *  addresses and made them permanently non-primary. Three tiers now. */
export type LanIpKind = 'rfc1918' | 'non-standard-private' | 'other';

/** One `/api/network` candidate: the address plus the marker the desktop's
 *  endpoint picker renders ("non-standard private segment"). Ordering is a DEFAULT, never a
 *  filter — nothing is hidden, because a hidden candidate the owner needs is a
 *  silent failure (CLAUDE.md red line: no silent failure). */
export interface LanCandidate {
  address: string;
  kind: LanIpKind;
  /** `kind === 'non-standard-private'` — mirrored as a field so the desktop does
   *  not have to re-implement the classification to draw the badge. */
  nonStandardPrivate: boolean;
}

const RFC1918 = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./;
/** Ranges that are NOT RFC1918 yet are, in practice, LAN-only wiring:
 *   • 100.64.0.0/10  — RFC6598 CGNAT (also what most mesh VPNs hand out);
 *   • the rest of 172.0.0.0/8 — the "looks like RFC1918 but isn't" family that
 *     office networks routinely co-opt (owner's 100.64.7.0/24);
 *   • 198.18.0.0/15  — RFC2544 benchmarking, used by several VPN clients.
 *  A phone CAN be on one of these with the PC, so they outrank public addresses;
 *  they still sort below true RFC1918 because that remains the common case. */
const NON_STANDARD_PRIVATE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^172\.|^198\.1[89]\./;

/** Pure classifier — the single definition of the three ordering tiers. */
export function classifyLanIpv4(ip: string): LanIpKind {
  if (RFC1918.test(ip)) return 'rfc1918';
  if (NON_STANDARD_PRIVATE.test(ip)) return 'non-standard-private';
  return 'other';
}

const TIER: Record<LanIpKind, number> = { 'rfc1918': 0, 'non-standard-private': 1, 'other': 2 };

/** Pure ordering core (GA-21): classify + stable-sort by tier. Every input
 *  survives to the output — this ranks, it never drops. */
export function rankLanIpv4(addresses: readonly string[]): LanCandidate[] {
  return addresses
    .map((address) => {
      const kind = classifyLanIpv4(address);
      return { address, kind, nonStandardPrivate: kind === 'non-standard-private' };
    })
    .sort((a, b) => TIER[a.kind] - TIER[b.kind]); // Array#sort is stable → NIC order kept within a tier
}

/** Enumerate this host's non-internal IPv4 addresses as ranked candidates.
 *  Link-local 169.254.x (APIPA — no DHCP lease yet) is excluded so the desktop's
 *  LAN-IP poll keeps waiting for a real address instead of latching a dead one
 *  (07 §5 / F-2343). Pure over an injectable interface map for testability. */
export function collectLanCandidates(
  ifaces: NodeJS.Dict<Array<{ family: string | number; address: string; internal: boolean }>> = networkInterfaces(),
): LanCandidate[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      const fam = ni.family === 4 || ni.family === 'IPv4';
      if (!fam || ni.internal) continue;
      if (/^169\.254\./.test(ni.address)) continue; // APIPA link-local
      out.push(ni.address);
    }
  }
  return rankLanIpv4(out);
}

/** The address-only view of `collectLanCandidates` (the historical `lan_ipv4`
 *  shape — kept verbatim so existing readers keep working). */
export function collectLanIpv4(
  ifaces: NodeJS.Dict<Array<{ family: string | number; address: string; internal: boolean }>> = networkInterfaces(),
): string[] {
  return collectLanCandidates(ifaces).map((c) => c.address);
}
