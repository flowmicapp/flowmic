// SPEC-REF:
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §2 (「加每 key /
//     每宿主 origin 的硬上限（控制台可设，缺省＝档位全量）… 任一上限到顶即拒收，
//     不降级为试用、不降级为 T 的其他 key、不因说话者登录而改道」), §4, §5
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §9-1
//   ../db/schema-integrator.ts (why the counter is a column and what rolls it)
//   ./capped-remaining.ts (the ONE `Math.min` all three enforcement points share)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Card MP-1 — the POLICY over `integrator_keys`: what a key string looks like,
// which pages a key may build a room from, and how much of the integrator's
// month this key still has.
//
// ── 🔴 THE PUBLISHABLE KEY IS NOT A SECRET, AND SAYING SO IS THE POINT ──────
//
// 「Publishable」 is Stripe's word for the same object and it means what it says:
// card MP-2 puts this string in a host page's own JavaScript, where every
// visitor can read it, and this repo's own `no-cloud-keys` lint is deliberately
// NOT taught to recognise it — that lint's job is to stop SECRETS entering the
// tree, and a value designed to be served to the public is not one. A rule there
// would fire on this card's own fixtures and would teach the next reader that
// leaking one matters, which is the opposite of true.
//
// 🔴 SO THE `Origin` HEADER IS NOT A SECURITY BOUNDARY EITHER, AND THE RESIDUAL
// IS NAMED RATHER THAN PAPERED OVER. A browser sets `Origin` and will not let a
// page forge it; `curl` will. Anyone holding a published key can therefore build
// rooms from a machine that is not the integrator's page, and every second they
// speak lands on the integrator's bill. That is INHERENT to the shape owner
// asked for (a key in a page), and the answer to it is not secrecy — it is
// BLAST RADIUS:
//   · the per-key sub-quota below is the ceiling on what a stolen key can cost;
//   · `revoked_at` is how it is stopped;
//   · `origins` keeps HONEST pages from being able to embed each other's key by
//     accident, which is the failure that actually happens.
// A comment claiming the Origin check was a defence would be exactly the
// 「confident explanation of why something is fine」 shape this repo hunts for.

import { randomBytes } from 'node:crypto';
import type { IntegratorKeyRepo, IntegratorKeyRow } from '../db/repos/integrator-key.repo';

/**
 * The prefix every publishable key carries.
 *
 * 🔴 A PREFIX SO A HUMAN READING A LOG LINE OR A PAGE'S SOURCE CAN TELL WHAT
 * THEY ARE LOOKING AT — the same reason `fm_` exists on the trial token and
 * `sk-`/`pk_` exist on everybody else's. It is not an authentication factor and
 * nothing branches on it except the shape check below, whose whole job is to
 * refuse an obviously-not-a-key string before it costs a database read.
 */
export const PUBLISHABLE_KEY_PREFIX = 'fmpk_';

/** 32 hex characters — 128 bits. Not a secret (see the header) but still
 *  unguessable: a key that could be walked would let anyone spend an
 *  integrator's minutes without ever visiting their page. */
const KEY_BYTES = 16;

export function newPublishableKey(): string {
  return `${PUBLISHABLE_KEY_PREFIX}${randomBytes(KEY_BYTES).toString('hex')}`;
}

/** Is this string shaped like one of ours? Cheap pre-check only — a `true`
 *  here proves nothing about whether the key exists or is live. */
export function looksLikePublishableKey(value: string): boolean {
  return new RegExp(`^${PUBLISHABLE_KEY_PREFIX}[0-9a-f]{${KEY_BYTES * 2}}$`).test(value);
}

/**
 * The exact `scheme://host[:port]` form an `Origin` header carries, or null.
 *
 * 🔴 EXACT-MATCH ONLY, NO WILDCARDS AND NO SUFFIX RULES. `*.example.com` reads
 * as generous and is not: it also matches a subdomain an attacker got hold of,
 * and a subdomain takeover is the ordinary way a third party's page ends up
 * hostile. An integrator who genuinely serves three subdomains lists three
 * origins — a console field, not a parser feature.
 *
 * ⚠️ NORMALISED ON BOTH SIDES so a stored `https://Example.com/` and a header
 * `https://example.com` are the same origin. The trailing slash is dropped
 * because browsers do not send one and humans type one.
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'null') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.protocol}//${url.host}`.toLowerCase();
}

/**
 * May this key build a room for a request that arrived with this `Origin`?
 *
 * 🔴 AN ABSENT `Origin` IS A REFUSAL, not a pass. A page always sends one on a
 * cross-origin POST; a request without one is either same-origin with the relay
 * (which no integrator page is) or not a browser at all. Treating absent as
 * 「no restriction applies」 is the classic CORS-allowlist inversion, and here it
 * would mean the ONLY thing on this path that costs an attacker anything can be
 * removed by deleting a header.
 */
export function originAllowed(key: Pick<IntegratorKeyRow, 'origins'>, header: string | undefined | null): boolean {
  const origin = normalizeOrigin(header);
  if (origin === null) return false;
  return key.origins.some((o) => normalizeOrigin(o) === origin);
}

/** Why a key may not be used right now, or null when it may. Two values rather
 *  than a boolean because the CALLER has to answer them differently: a revoked
 *  key and an unknown one are deliberately one HTTP answer, while an origin
 *  mismatch is another. */
export type KeyRefusal = 'unknown' | 'revoked' | 'origin';

export interface IntegratorKeyGuard {
  /** Resolve a presented key + Origin into a usable row, or say why not. */
  admit(publishableKey: string, origin: string | undefined | null):
  | { ok: true; key: IntegratorKeyRow }
  | { ok: false; reason: KeyRefusal };
  /**
   * How many more milliseconds of transcription this key may spend in the
   * integrator's CURRENT billing cycle.
   *
   * `Number.POSITIVE_INFINITY` when the key sets no sub-quota — which is what
   * NULL `quota_minutes` means, and what makes `Math.min` with it a no-op rather
   * than a ceiling this module invented (schema-integrator.ts argues why the
   * default is an absence and not a copy of T's plan number).
   *
   * 🔴 A KEY THIS PROCESS CANNOT FIND ANSWERS 0, NOT INFINITY. Design §5: a
   * replica that cannot read the sub-quota must lean toward refusing. Zero is
   * how 「lean toward refusing」 is expressed in a number that flows into a
   * `Math.min` — every other value would let an unreadable ceiling become no
   * ceiling at all.
   */
  remainingMs(keyId: string, at: number): number;
  /** Which key minted this room, or null. */
  keyIdForRoom(pcDeviceId: string): string | null;
}

export interface IntegratorKeyGuardDeps {
  keys: Pick<IntegratorKeyRepo, 'findByPublishableKey' | 'findById' | 'keyIdForRoom'>;
  /** `BillingService.usagePeriodKey` — MUST be the same one the meter writes
   *  with, or the counter and the cycle it is compared against would roll on
   *  two different days. */
  usagePeriodKey(user_id: string, atMs: number): string;
}

export function makeIntegratorKeyGuard(deps: IntegratorKeyGuardDeps): IntegratorKeyGuard {
  return {
    admit(publishableKey, origin) {
      if (!looksLikePublishableKey(publishableKey)) return { ok: false, reason: 'unknown' };
      const key = deps.keys.findByPublishableKey(publishableKey);
      if (key === null) return { ok: false, reason: 'unknown' };
      if (key.revoked_at !== null) return { ok: false, reason: 'revoked' };
      // AFTER the key is known, so a caller cannot learn whether a key exists by
      // watching which refusal it gets for a bad origin. Both refusals are
      // answered by the route, and the route folds `unknown` and `revoked` into
      // one reply for the same reason the trial ledger folds unknown and
      // expired.
      if (!originAllowed(key, origin)) return { ok: false, reason: 'origin' };
      return { ok: true, key };
    },
    remainingMs(keyId, at): number {
      const key = deps.keys.findById(keyId);
      if (key === null) return 0;
      if (key.revoked_at !== null) return 0;
      if (key.quota_minutes === null || !Number.isFinite(key.quota_minutes)) {
        return Number.POSITIVE_INFINITY;
      }
      const period = deps.usagePeriodKey(key.user_id, at);
      // A counter stamped with a DIFFERENT cycle reads as zero used — that is
      // the rollover, and it happens on read so nothing has to sweep.
      const used = key.used_period === period ? key.used_ms : 0;
      return Math.max(0, key.quota_minutes * 60_000 - used);
    },
    keyIdForRoom(pcDeviceId): string | null {
      return deps.keys.keyIdForRoom(pcDeviceId);
    },
  };
}
