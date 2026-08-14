// SPEC-REF:
//   docs/rebuild/13-LESSONS-LEARNED.md §6.4 (X-Forwarded-For is spoofable
//     WITHOUT a trusted-proxy config — this module IS that config; 13 §6.4's
//     "deferred to the Cloudflare stage" note is closed by this file)
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §1/§5.5 (saas binds loopback behind
//     an edge proxy — which is exactly why every per-IP limiter used to see
//     127.0.0.1 for the whole internet)
//   *** HUMAN-AUDIT SENSITIVE (access control / rate-limit identity) —
//       reviewable in isolation ***
//
// THE PROBLEM (0.3.0 M3): every per-IP limiter keyed on the DIRECT peer. Behind
// nginx the direct peer of every public request is 127.0.0.1, so register +
// login shared ONE global 5/10-min bucket — six requests from anywhere locked
// out the whole world — and the pairing limiter was the same DoS in a different
// room. The fix is a single client-IP derivation used by every per-IP decision:
//
//   • If the direct peer IS a configured trusted proxy, the client is the
//     RIGHTMOST hop of X-Forwarded-For that is not itself a trusted proxy.
//     Rightmost, never leftmost: the leftmost hops are whatever the CLIENT
//     chose to send (fully forgeable); the rightmost untrusted hop is the one
//     the trusted proxy itself appended from the TCP connection it accepted.
//   • If the direct peer is NOT a trusted proxy — including the default, where
//     no proxy is configured at all — the header is IGNORED and the direct
//     peer is the answer, byte-for-byte today's behaviour. Fail-safe: an
//     unset/garbage config can only ever mean "trust nobody", never "trust
//     everybody".
//
// CONFIG — `FLOWMIC_TRUSTED_PROXIES`: a comma-separated list of LITERAL IP
// addresses of the reverse proxies whose X-Forwarded-For we accept (typical
// VPS value: `127.0.0.1,::1` for a same-box nginx). Semantics, precisely:
//   · literal IPs only — no CIDR, no hostnames. A cheap exact-match compare is
//     auditable at a glance; widening to ranges is a deliberate future change,
//     not something to sneak in via a clever parse;
//   · IPv6-mapped IPv4 (`::ffff:127.0.0.1`) is normalised to its dotted form on
//     BOTH sides, so `127.0.0.1` in the config matches the dual-stack peer
//     shape Node actually reports on Windows;
//   · entries that do not parse as an IP are DROPPED with a structured warn —
//     never a throw (a config typo must not take the server down) and never a
//     silent widening of trust;
//   · unset / empty ⇒ no trusted proxies ⇒ every call site behaves exactly as
//     it did before this module existed.
//
// The nginx side of the contract (documented here because the derivation is
// only as good as the appender): the proxy must APPEND the observed client to
// the header (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
// A proxy that passes the client's header through UNTOUCHED downgrades this
// derivation to today's shared-bucket behaviour at worst (we fall back to the
// peer when the header yields nothing usable) — it never lets a forged hop win,
// because the forged hops sit to the LEFT of where an appending proxy writes.
//
// 🔴 CORRECTION (IT-06 / anti-façade ④, 2026-08-05) — the two sentences above
// after the append directive are kept as the expired claim; they were
// MEASURED FALSE against `clientIpFrom` in this same file.
//
//   What the code actually does (`clientIpFrom`): when the direct peer IS a
//   trusted proxy, the answer is the RIGHTMOST hop that is not itself trusted
//   (and that parses as an IP). Under a pass-through proxy the client-supplied
//   X-Forwarded-For is the whole chain, so a forged hop IS that rightmost
//   untrusted hop and is believed. Inline check (peer=`127.0.0.1` trusted,
//   xff=`203.0.113.9`): returns `203.0.113.9`, not the peer. The comment's
//   "forged hops sit to the LEFT" premise only holds when an appending proxy
//   has written a real hop after them — pass-through never does that.
//
//   What is still true today, and must stay visible: production nginx uses
//   `$proxy_add_x_forwarded_for` in all four `proxy_set_header X-Forwarded-For`
//   sites (grep anchors: the private deployment repo's nginx config and this
//   repo's `docs/legacy-reference/deploy-templates/nginx.flowmic.app.conf`).
//   Append-style means a forged left hop cannot become the rightmost untrusted
//   hop. So the false claim is NOT a live exploit against the deployed edge —
//   it is a false generalisation about pass-through. Do not promote this into
//   a production vulnerability report; do not dismiss it as a non-issue either:
//   any future fronting proxy that switches to pass-through silently turns the
//   derivation into a client-controlled bucket key.
//
// ── DEPLOYMENT CONTRACT (travels with the code that depends on it) ──────────
// The fronting reverse proxy MUST be APPEND-style for X-Forwarded-For
// (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
// Pass-through (`$http_x_forwarded_for` alone, or forwarding the client header
// untouched) is FORBIDDEN for any peer listed in `FLOWMIC_TRUSTED_PROXIES`:
// under that shape `clientIpFrom` will believe a forged rightmost hop. This
// constraint is load-bearing for every per-IP limiter that keys on
// `clientIpFromRequest` / `clientIpFromHandshake`.
//
// WHAT THIS MODULE IS NOT: an authorisation oracle. local-only.ts's localness
// gate consumes the derivation, but under a strict extra rule enforced THERE:
// X-Forwarded-For may only ever REVOKE localness, never grant it (the raw
// direct peer must be loopback regardless). Bucket identity may follow the
// header; "is this caller this machine" must never follow it upward.

import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { log } from '../log';

/** The env key. Grep-anchor for the production consumers: every per-IP limiter
 *  call site derives its key through `clientIpFromRequest` /
 *  `clientIpFromHandshake`, whose default trust list is `trustedProxiesFromEnv`
 *  reading this. */
export const TRUSTED_PROXIES_ENV = 'FLOWMIC_TRUSTED_PROXIES';

/** Canonical compare form: trimmed, unbracketed, lowercased, and IPv6-mapped
 *  IPv4 (`::ffff:a.b.c.d`) collapsed to plain dotted `a.b.c.d`. */
export function normalizeAddr(addr: string): string {
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1); // bracketed IPv6
  if (a.startsWith('::ffff:') && isIP(a.slice('::ffff:'.length)) === 4) {
    a = a.slice('::ffff:'.length);
  }
  return a;
}

export interface ParsedTrustedProxies {
  /** Normalised literal IPs that made the trust list. */
  proxies: string[];
  /** Entries dropped for not being literal IPs (reported, never trusted). */
  rejected: string[];
}

/** Safe parse of the comma-separated env value. Pure — no env read, no log —
 *  so tests can pin every branch; the env wrapper below owns the warn. */
export function parseTrustedProxies(raw: string | undefined): ParsedTrustedProxies {
  const proxies: string[] = [];
  const rejected: string[] = [];
  for (const piece of (raw ?? '').split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue; // empty segments (trailing comma) are not junk
    const normalized = normalizeAddr(trimmed);
    if (isIP(normalized)) proxies.push(normalized);
    else rejected.push(trimmed);
  }
  return { proxies, rejected };
}

// Memoised on the RAW env string: the parse (and the warn about dropped junk)
// happens once per distinct value, not once per request. Tests that flip
// process.env mid-file still see the change — the raw string is re-read every
// call and a changed value re-parses.
let cachedRaw: string | null = null;
let cachedList: readonly string[] = [];

/** The trust list production call sites use by default. */
export function trustedProxiesFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[TRUSTED_PROXIES_ENV] ?? '';
  if (raw === cachedRaw) return cachedList;
  const { proxies, rejected } = parseTrustedProxies(raw);
  if (rejected.length > 0) {
    log.warn('trusted-proxy: dropped FLOWMIC_TRUSTED_PROXIES entries that are not literal IPs (they are NOT trusted)', {
      rejected,
      kept: proxies,
    });
  }
  cachedRaw = raw;
  cachedList = proxies;
  return cachedList;
}

/** Exact-match against the (already normalised) trust list. */
export function isTrustedProxy(addr: string, trusted: readonly string[]): boolean {
  if (trusted.length === 0) return false;
  return trusted.includes(normalizeAddr(addr));
}

/**
 * THE single client-IP derivation (see the file head for the two rules).
 *
 * Malformed-hop guard: if the rightmost untrusted hop does not parse as an IP,
 * the answer falls back to the DIRECT PEER — never the junk string. Two reasons,
 * both load-bearing:
 *   · per-IP limiter state is a Map keyed by this return value; letting a
 *     caller-controlled arbitrary string become a key hands an attacker
 *     unbounded map cardinality (a memory DoS bought with one header);
 *   · a well-configured appending proxy writes the rightmost hop from the TCP
 *     peer address, so a malformed rightmost hop only occurs under proxy
 *     misconfiguration — where falling back to the peer IS today's behaviour.
 */
export function clientIpFrom(
  peer: string,
  xff: string | string[] | undefined,
  trusted: readonly string[],
): string {
  if (!isTrustedProxy(peer, trusted)) return peer; // covers the empty-list default
  const raw = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
  const hops = raw.split(',').map((h) => normalizeAddr(h)).filter((h) => h !== '');
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (isTrustedProxy(hop, trusted)) continue; // our own proxies are not clients
    return isIP(hop) ? hop : peer;
  }
  // No header, or every hop is one of our proxies: the request originated on
  // the proxy chain itself — the peer is the honest bucket for it.
  return peer;
}

/** Derivation over an http request: direct peer + its X-Forwarded-For. Both
 *  reads are optional-chained, same fail-safe as local-only.peerAddress: a
 *  half-built request (gone socket; hand-built test double without headers)
 *  degrades to "no evidence", never a throw inside an access-control path. */
export function clientIpFromRequest(
  req: IncomingMessage,
  trusted: readonly string[] = trustedProxiesFromEnv(),
): string {
  return clientIpFrom(req.socket?.remoteAddress ?? '', req.headers?.['x-forwarded-for'], trusted);
}

/** The socket.io handshake carries the same two facts under different names —
 *  structural type so unit tests need no socket.io server.
 *
 *  `headers` is optional ON PURPOSE. socket.io's real handshake always has the
 *  bag, but the things that reach this function in practice do not all come
 *  from socket.io: test doubles and hand-built socket stand-ins routinely carry
 *  only `address`. Typing it as required made those call sites compile while
 *  throwing at runtime — see the note on clientIpFromHandshake. */
export interface HandshakeLike {
  address?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** Derivation over a socket.io handshake (mobile:pair / mobile:login limiters).
 *
 *  🔴 Both reads are optional-chained, and that is load-bearing, not defensive
 *  habit: this function runs INSIDE the rate-limiter path of `mobile:pair` and
 *  `mobile:login` (mobile.handler.ts / auth.handler.ts `socketIp`). A throw here
 *  does not degrade a limiter — it aborts the handler that was about to admit or
 *  refuse a device. A missing header bag must therefore mean "no evidence" and
 *  fall back to the direct peer, exactly like clientIpFromRequest above.
 *
 *  How this was found (worth keeping): the header read was written WITHOUT the
 *  optional chain while the sibling doc comment already claimed both reads had
 *  it. Thirteen presence tests died with
 *  `TypeError: Cannot read properties of undefined (reading 'x-forwarded-for')`
 *  — a comment asserting behaviour the code did not have (anti-façade ④). */
export function clientIpFromHandshake(
  handshake: HandshakeLike | undefined,
  trusted: readonly string[] = trustedProxiesFromEnv(),
): string {
  return clientIpFrom(handshake?.address ?? '', handshake?.headers?.['x-forwarded-for'], trusted);
}
