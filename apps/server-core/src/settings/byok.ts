// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §5 (`stt.routings` / `stt.byok_enabled`)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (BYOK = user-authored routing)
//   settings/provenance.ts (seed vs user — GET must not show platform seeds
//     as if the owner typed them)
//   *** HUMAN-AUDIT SENSITIVE (auth-adjacent: BYOK keys + probe dial) ***
//
// Console BYOK policy. Three questions, three functions — never one value
// answering two of them:
//   · What does a brand-new SaaS account store?          seedSaasByokEmpty
//   · May the engine router use the user's own rows?     isByokEnabled
//   · Which rows may the console editor display?         authoredRoutings
//
// 🔴 SaaS register used to call seedDefaultSettings, which writes the stock
// STT presets (sherpa-local, or whatever FLOWMIC_DEFAULT_STT_*_PRESET names).
// Those rows are `provenance:'seed'` so they do not steal traffic from the
// managed default — but GET /api/cloud/stt-routings returned them verbatim, so
// a new account's BYOK page looked pre-filled. Owner 2026-08-14: the page
// starts empty; the user configures it. This module writes `[]` + `false`
// BEFORE seedDefaultSettings so the existing key is not overwritten.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isSeedMarked, STT_ROUTINGS_KEY } from './provenance';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { isLoopbackAddress } from '../http/local-only';

/** Console master switch. Absent ⇒ do not change existing routing behaviour
 *  (standalone seeds and already-configured BYOK keep working). `false` is
 *  written explicitly on SaaS register. */
export const BYOK_ENABLED_KEY = 'stt.byok_enabled';

/** Rows the console may show or echo — platform seeds are not the user's. */
export function authoredRoutings(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => !isSeedMarked(row));
}

/**
 * Engine-router question. Absent is TRUE on purpose: a desktop / pre-switch
 * account must keep today's selection. Only an explicit `false` (the SaaS
 * register write, or the console toggle) drops user-authored rows.
 */
export function isByokEnabled(settings: SettingsRepo, userId: string): boolean {
  const row = settings.read(userId, BYOK_ENABLED_KEY);
  if (row === null) return true;
  return row.value === true;
}

/**
 * What the console paints for the switch. Distinct from {@link isByokEnabled}:
 * a missing key on an account that already has user rows must show ON
 * (grandfather), and a missing key with no user rows must show OFF (empty
 * page). Routing does not use this function.
 */
export function consoleByokEnabled(settings: SettingsRepo, userId: string, authored: readonly unknown[]): boolean {
  const row = settings.read(userId, BYOK_ENABLED_KEY);
  if (row !== null) return row.value === true;
  return authored.length > 0;
}

/** First-write only. Never overwrites a row the user (or an older seed) owns. */
export function seedSaasByokEmpty(repo: SettingsRepo, userId: string): string[] {
  const written: string[] = [];
  if (repo.read(userId, STT_ROUTINGS_KEY) === null) {
    repo.write(userId, STT_ROUTINGS_KEY, []);
    written.push(STT_ROUTINGS_KEY);
  }
  if (repo.read(userId, BYOK_ENABLED_KEY) === null) {
    repo.write(userId, BYOK_ENABLED_KEY, false);
    written.push(BYOK_ENABLED_KEY);
  }
  return written;
}

/**
 * Node's WHATWG URL parser spells an IPv4-mapped IPv6 literal as the packed
 * hex form (`[::ffff:169.254.169.254]` in a URL becomes hostname
 * `::ffff:a9fe:a9fe`), while a resolver or an operator may just as well hand
 * back the dotted-decimal spelling (`::ffff:169.254.169.254`). Both name the
 * same address; collapse either to plain dotted-decimal so every check below
 * only has to know "IPv4 or plain IPv6", not which of the two an operator (or
 * an attacker) chose to write.
 */
function unwrapIpv4Mapped(address: string): string {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted) return dotted[1] as string;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const h1 = parseInt(hex[1] as string, 16);
    const h2 = parseInt(hex[2] as string, 16);
    return `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
  }
  return address;
}

/**
 * True for any address the probe must never actually dial: loopback,
 * link-local (this single range already covers the 169.254.169.254 cloud
 * metadata address on AWS/GCP/Azure alike — it is not a coincidence that
 * every provider picked a link-local address for it), the unspecified
 * address, and any IPv4-mapped IPv6 spelling of those. RFC1918 is NOT here on
 * purpose — see the function header below: a BYOK engine on the owner's own
 * LAN/VPN is a valid target — the existence proof is the owner's VPN-segment
 * address in this file's own test.
 */
function isBlockedAddress(address: string): boolean {
  const addr = unwrapIpv4Mapped(address);
  if (isLoopbackAddress(addr)) return true;
  if (isIP(addr) === 4) {
    const octets = addr.split('.').map(Number);
    if (octets[0] === 169 && octets[1] === 254) return true; // link-local incl. cloud metadata
    if (octets[0] === 0) return true; // 0.0.0.0/8 — "unspecified" / "this network"
    return false;
  }
  const lower = addr.toLowerCase();
  if (lower === '::') return true; // unspecified
  if (isIP(lower) === 6) {
    // fe80::/10 — first hextet ranges 0xfe80..0xfebf. `lower.split(':')[0]` is
    // '' for anything starting with '::' (already handled above as loopback
    // or unspecified), so a parse failure here just means "not fe80::/10".
    const firstHextet = parseInt(lower.split(':')[0] ?? '', 16);
    if (!Number.isNaN(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
  }
  return false;
}

export interface ByokProbeEndpointDeps {
  /** Test seam. Production default: `dns.lookup(hostname, {all:true})` — EVERY
   *  address a real connect could land on, not just the first (Happy Eyeballs
   *  / round-robin DNS may pick any record in the list). */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/**
 * Cloud TEST may not turn the VPS into a loopback / metadata scanner.
 * RFC1918 is allowed: a user's engine may live on a network the relay can
 * already reach (the owner's own VPN path is the existence proof).
 *
 * Two layers, kept BOTH:
 *  ① the literal-hostname / literal-IP string check — cheap, and it cannot be
 *    fooled by a DNS answer because it never asks DNS anything;
 *  ② resolve-then-check — a hostname is judged by what it ACTUALLY resolves
 *    to, so `metadata.flowmic-attacker.example` pointed at 169.254.169.254 is
 *    refused exactly like the literal address is.
 * 🔴 What this does NOT close: DNS rebinding between this check and the
 * connect `probeStt` performs a few milliseconds later (the resolver could
 * answer safely here and answer 169.254.169.254 on the next lookup). Closing
 * that needs the actual dial pinned to the address checked here — the probe's
 * real network call lives inside per-engine transports (stt/engines/*.ts, one
 * fetch-based or ws-based client per SttEngineId), not in this module, and
 * pinning all of them was judged out of scope for this pass. Recorded here
 * rather than silently left out (CLAUDE.md anti-façade discipline).
 */
export async function byokProbeEndpointAllowed(
  endpoint: string,
  deps: ByokProbeEndpointDeps = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const trimmed = endpoint.trim();
  if (trimmed === '') return { ok: false, reason: 'endpoint required' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'endpoint is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, reason: 'endpoint scheme must be http(s) or ws(s)' };
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return { ok: false, reason: 'endpoint must be reachable from FlowMic servers — loopback is not' };
  }
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    return { ok: false, reason: 'this address is not a valid engine endpoint' };
  }
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bareHost) !== 0) {
    // A literal IP typed directly must be judged by RANGE, not just the three
    // exact strings above — 127.0.0.2 or ::ffff:169.254.169.254 are not
    // byte-for-byte "127.0.0.1" / "169.254.169.254" but are the same address
    // class.
    if (isBlockedAddress(bareHost)) return { ok: false, reason: 'this address is not a valid engine endpoint' };
    return { ok: true };
  }
  // RESOLVE-THEN-CHECK: the string checks above cannot see a hostname whose
  // DNS answer IS 169.254.169.254 — this is the fix for that gap.
  let addresses: string[];
  try {
    addresses = await (deps.resolveHost ?? defaultResolveHost)(bareHost);
  } catch (err) {
    return { ok: false, reason: `endpoint host could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'endpoint host could not be resolved' };
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, reason: 'this address is not a valid engine endpoint' };
    }
  }
  return { ok: true };
}
