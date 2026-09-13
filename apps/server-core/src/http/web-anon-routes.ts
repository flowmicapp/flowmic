// SPEC-REF:
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.2 (the
//     sequence), §2.3 (token TTL and the grant), §3.1 (the five gates, and that
//     their ORDER is the failure direction), §3.2 (the five log lines)
//   docs/decisions/2026-09-09-owner-stage4-site-demo-twelve-rulings.md rulings
//     1 (anonymous identity, not a shared demo account), 3 (a room is minted
//     only after the visitor clicks), 4 (these dials, these defaults), 11
//   ../auth/captcha.ts (the ONE 「did a person solve a challenge」 question)
//   ../site/sanitize.ts `originAllowed` (the ONE origin allow-list)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//     (owner 2026-09-11 — one lifetime 120 s per browser identity; the caps in
//     this file are ABUSE ceilings and were never the allowance)
//   ../billing/trial-ledger.ts (how long this visitor may speak)
//   *** HUMAN-AUDIT SENSITIVE (auth: this route mints a users row for a caller
//       who proved nothing but a Turnstile solve) ***
//
// `POST /api/web/anon` — a visitor on the marketing site asks for a demo
// identity.
//
// ── WHAT IT HANDS OUT, AND WHAT THAT OPENS ─────────────────────────────────
// An opaque `fm_` token that opens EXACTLY ONE DOOR: the anonymous arm of
// `POST /api/web/rooms`. It is not an account JWT and `accountFromBearer` has
// never heard of it, which is deliberate — a JWT would have opened every account
// route on this server for an hour on behalf of a row nobody authenticated.
//
// ── THE GATE ORDER IS NOT THE DESIGN REGISTER'S LIST ORDER ─────────────────
// §3.1 lists the gates in FAILURE DIRECTION (which one, if it broke, would be
// worst). This file runs them in COST order within that, and the deviation is
// deliberate and small: the master switch and the Origin are string comparisons
// on data already in hand, the per-IP burst brake is a Map lookup, and Turnstile
// is a NETWORK ROUND TRIP TO CLOUDFLARE. Verifying first would let anyone spend
// our siteverify budget from a disallowed page. No gate is skipped and none is
// weakened; only the order they are asked in changes.
//
// 🔴 EVERY REFUSAL WRITES ONE LINE WITH ITS OWN `reason`, and that is the whole
// of §3.2's fourth line. Without it 「the demo is being farmed」 and 「the demo is
// switched off」 look identical from outside: both are a page that will not
// start. The codes on the wire deliberately collapse four causes into
// WEB_DEMO_UNAVAILABLE (see error-codes.ts for why); the log is where they are
// told apart, because that is where telling them apart is actionable.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CaptchaVerifier } from '../auth/captcha';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { TrialLedger } from '../billing/trial-ledger';
import { ipBucketOf } from '../billing/trial-ip-bucket';
import { newToken } from '../auth/token';
import { originAllowed } from '../site/sanitize';
import { readJsonBody, sendJson, str } from './console-http';
import { clientIpFromRequest } from './trusted-proxy';
import { log } from '../log';

/** How long a demo identity's token is good for — design §2.3. One hour, and
 *  there is no refresh endpoint: a visitor who is still there an hour later
 *  clicks again and gets a new one, which is cheaper than a second credential
 *  with its own rotation rules. */
export const ANON_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Per-IP burst brake: 5 mints a minute. A person clicking 「start」 five times in
 *  a minute is already unusual; this is the shape of a script, not of impatience. */
export const ANON_BURST_MAX = 5;
export const ANON_BURST_WINDOW_MS = 60_000;

/** The three dials owner set on 2026-09-09 (ruling 4). Each is overridable by
 *  env because they are dials — but each DEFAULT is the ruling, so a deployment
 *  that sets nothing gets what was decided rather than what was convenient.
 *
 *  🔴 THEY ARE ABUSE CEILINGS AND NOT AN ALLOWANCE, and owner §10 (2026-09-11)
 *  is what makes the distinction load-bearing. Before it, the per-network count
 *  ALSO decided how many seconds a visitor got (120 → 60 → 30 → 0); it no longer
 *  does. A request these gates let through gets whatever `TrialLedger.claim`
 *  says is left of that browser's one 120 s, which may be nothing at all. */
export const ANON_MAX_PER_IP_PER_DAY = 10;
export const ANON_DAILY_MINUTES = 600;
export const ANON_MAX_ACTIVE_ROOMS = 200;

/** Why one request was turned away. These strings are the operator's, never the
 *  visitor's: they go in a log line and never on the wire (a caller who learns
 *  WHICH gate stopped them is being handed a tuning signal — the rule
 *  google-auth-routes.ts states). */
export type TrialRefusalReason =
  | 'disabled' | 'origin' | 'ip_burst' | 'turnstile' | 'ip_daily' | 'global_daily' | 'active_rooms';

export interface WebAnonRoutesDeps {
  /** The master switch. `false` ⇒ every request is a 503 that says so in the
   *  log; nothing degrades quietly. */
  enabled: boolean;
  /** The ONE captcha question. Its `configured` half is read separately from its
   *  `verify` half, because auth/captcha.ts keeps 「we cannot check」 and 「they
   *  failed」 apart and this route must too. */
  captcha: CaptchaVerifier;
  trials: TrialLedger;
  /** Its OWN RegisterRateLimiter instance, keyed on an IP bucket — never shared
   *  with register/login, whose budget answers a different question about a
   *  different action. */
  limiter: RegisterRateLimiter;
  /** The salt behind `ip_bucket`. Passed in so the derivation is testable
   *  without the process env. */
  ipSalt: string;
  /** How many demo rooms are live right now — the registry's own count, not a
   *  number this file keeps. Injected so this route never reaches the room
   *  store. */
  activeDemoRooms(): number;
  /** Localhost origins are allowed only where `originAllowed`'s own caller says
   *  so: vitest and `pnpm dev`. */
  allowLocalhost?: boolean;
  maxPerIpPerDay?: number;
  dailyMinutes?: number;
  maxActiveRooms?: number;
  now?: () => number;
}

/** Resolve the env dials once, at the wiring root. A malformed value falls back
 *  to the ruling's default rather than to NaN — the same rule
 *  `resolveBudgetHeartbeatMs` states: NaN would silently disable a cap. */
export function anonDialsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean; maxPerIpPerDay: number; dailyMinutes: number; maxActiveRooms: number;
} {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    // UNSET IS OFF. owner ruling 4: the switch is thrown on launch day, by a
    // person. A default of on would mean a deployment starts serving demos the
    // moment it is upgraded.
    enabled: (env.FLOWMIC_WEB_ANON_ENABLED ?? '') === '1',
    maxPerIpPerDay: num(env.FLOWMIC_WEB_ANON_MAX_PER_DAY, ANON_MAX_PER_IP_PER_DAY),
    dailyMinutes: num(env.FLOWMIC_WEB_ANON_DAILY_MINUTES, ANON_DAILY_MINUTES),
    maxActiveRooms: num(env.FLOWMIC_WEB_ANON_MAX_ACTIVE_ROOMS, ANON_MAX_ACTIVE_ROOMS),
  };
}

/** The Origin gate, shared with the anonymous arm of `/api/web/rooms` so the two
 *  endpoints cannot drift into two answers. A MISSING Origin is refused: 「we
 *  could not tell」 is never the loose arm of a gate. */
export function demoOriginOf(req: IncomingMessage, allowLocalhost: boolean): string | null {
  const origin = str(req.headers?.origin);
  return origin !== '' && originAllowed(origin, allowLocalhost) ? origin : null;
}

function refuse(
  res: ServerResponse,
  status: number,
  error: string,
  reason: TrialRefusalReason,
  extra: Record<string, unknown> = {},
): void {
  log.warn('trial refused', { reason, ...extra });
  sendJson(res, status, { error });
}

/** Returns true iff this request belonged to this file. */
export function tryHandleWebAnonRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebAnonRoutesDeps,
): boolean {
  const path = (req.url ?? '/').split('?')[0];
  if (path !== '/api/web/anon' || req.method !== 'POST') return false;

  void handle(req, res, deps).catch((err: unknown) => {
    // Same reason web-room-routes.ts catches here: the body of this route is a
    // detached promise, so an uncaught throw would be an UNANSWERED REQUEST —
    // the silent-failure red line in its worst form, because the card would sit
    // in its minting state with no status to render.
    log.error('web anon mint failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'SETTINGS_SYNC_FAIL', message: 'internal error' });
  });
  return true;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebAnonRoutesDeps,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const allowLocalhost = deps.allowLocalhost === true;

  // ── ① IS THE DEMO BEING SERVED AT ALL ───────────────────────────────────
  // The switch and 「no Turnstile secret」 answer the same 503 on purpose: from
  // the visitor's side they are one fact (not available now). The log line is
  // where they part company, and `configured:false` is read from the verifier
  // itself rather than from a second env read here.
  if (!deps.enabled || !deps.captcha.configured) {
    refuse(res, 503, 'WEB_DEMO_UNAVAILABLE', 'disabled', {
      enabled: deps.enabled, captcha: deps.captcha.id,
    });
    return;
  }

  // ── ② WHERE DID THIS COME FROM ──────────────────────────────────────────
  const origin = demoOriginOf(req, allowLocalhost);
  if (origin === null) {
    refuse(res, 403, 'WEB_ROOM_ORIGIN_NOT_ALLOWED', 'origin', { origin: str(req.headers?.origin) || '(none)' });
    return;
  }

  const ip = clientIpFromRequest(req);
  const ipBucket = ipBucketOf(ip, deps.ipSalt);

  // ── ③ HOW FAST ──────────────────────────────────────────────────────────
  // Before Turnstile: this one costs a Map lookup and that one costs a request
  // to Cloudflare (see the header).
  const burst = deps.limiter.check(ipBucket);
  if (!burst.allowed) {
    refuse(res, 429, 'WEB_ROOM_RATE_LIMITED', 'ip_burst', { ip_bucket: ipBucket, retry_after_ms: burst.retryAfterMs });
    return;
  }

  // ── ④ IS THERE A PERSON ─────────────────────────────────────────────────
  const body = await readJsonBody(req);
  const solved = await deps.captcha.verify(str(body.turnstile), ip);
  if (!solved) {
    // Recorded against the burst brake even though nothing was minted: a script
    // failing the challenge repeatedly is exactly what that brake is for, and a
    // gate that only counts SUCCESSES cannot slow one down.
    deps.limiter.record(ipBucket);
    refuse(res, 400, 'WEB_ROOM_TURNSTILE_FAILED', 'turnstile', { ip_bucket: ipBucket });
    return;
  }

  // ── ⑤ HOW MANY FROM THIS NETWORK TODAY ──────────────────────────────────
  // Persistent (a row count), unlike ③ which lives in memory: a relay restart
  // must not hand a network ten fresh identities.
  const maxPerIp = deps.maxPerIpPerDay ?? ANON_MAX_PER_IP_PER_DAY;
  const mintedToday = deps.trials.bucketCountToday(ipBucket, now);
  if (mintedToday >= maxPerIp) {
    refuse(res, 429, 'WEB_ROOM_RATE_LIMITED', 'ip_daily', { ip_bucket: ipBucket, minted_today: mintedToday });
    return;
  }

  // ── ⑥ HOW MUCH IS THE WHOLE SITE SPENDING TODAY ─────────────────────────
  // 🔴 MEASURED ON MINUTES SPENT, not minutes handed out. The two differ a lot
  // (most visitors say two sentences and leave), and the number owner set is a
  // COST ceiling — cost follows what was said. `msUsedOn` reads `usage_records`,
  // the one meter (db/schema-trial.ts says why there is no second one).
  // ⚠️ A demo already in flight is never cut off by this gate; §3.1 gate 5 is
  // explicit that an identity that was granted its time gets to finish.
  const dailyMs = (deps.dailyMinutes ?? ANON_DAILY_MINUTES) * 60_000;
  const usedMs = deps.trials.msUsedToday(now);
  if (usedMs >= dailyMs) {
    refuse(res, 503, 'WEB_DEMO_UNAVAILABLE', 'global_daily', { used_ms: usedMs, cap_ms: dailyMs });
    return;
  }

  const maxRooms = deps.maxActiveRooms ?? ANON_MAX_ACTIVE_ROOMS;
  const liveRooms = deps.activeDemoRooms();
  if (liveRooms >= maxRooms) {
    refuse(res, 503, 'WEB_DEMO_UNAVAILABLE', 'active_rooms', { live_rooms: liveRooms, cap: maxRooms });
    return;
  }

  // ── ⑦ CLAIM ─────────────────────────────────────────────────────────────
  // owner §10 — 「claim」 and not 「mint」: a browser that has been here before
  // lands on the identity it already has, with whatever is left of its one two
  // minutes. `device_uid` is the `wb-…` value the web client keeps in
  // localStorage; a client that sends none gets a fresh identity every time,
  // which is the honest degradation and is bounded by the gates above.
  //
  // 🔴 THE VALUE IS NOT AUTHENTICATED, AND IT DOES NOT NEED TO BE. Claiming
  // somebody else's uid can only ever hand the claimant LESS time (that
  // identity's remainder), never more — the one direction of the trade this
  // ruling cares about. Guessing one is also not a way in: the trial identity is
  // reached through the token minted here, and the uid opens nothing by itself.
  deps.limiter.record(ipBucket);
  const claimed = deps.trials.claim({
    deviceUid: str(body.device_uid) || null,
    ipBucket, nowMs: now, tokenTtlMs: ANON_TOKEN_TTL_MS, newId: randomUUID, newToken,
  });
  // §3.2 line 1. `reused` is the field that makes 「why does this visitor only
  // have 20 seconds」 answerable from the log alone — it says the allowance was
  // not handed out again, which under owner §10 is the whole rule. No IP, no
  // user agent, no referrer — the bucket is a hash and that is all that is kept.
  log.info(claimed.reused ? 'web anon reclaimed' : 'web anon minted', {
    anon_id: claimed.userId,
    ip_bucket: ipBucket,
    reused: claimed.reused,
    grants_used_today: claimed.grantsUsedToday,
    granted_ms: claimed.grantedMs,
    remaining_ms: claimed.remainingMs,
    origin,
  });
  sendJson(res, 200, {
    anon_token: claimed.token,
    // Seconds, matching the contract addendum's `expires_in` (§2.2) rather than
    // this server's usual ms — the field name is the contract's and so is its unit.
    expires_in: Math.floor(ANON_TOKEN_TTL_MS / 1000),
    // The LIFETIME allowance on this identity. Unchanged in meaning and
    // unchanged by a reuse — it is the SAME number `effectiveLimits` enforces
    // (billing/trial-ledger.ts owns both), not a second arithmetic.
    granted_ms: claimed.grantedMs,
    // 🔴 ADDITIVE, AND owner §10 IS WHY IT HAD TO BE ADDED. Before the ruling,
    // a minted identity had spent nothing, so `granted_ms` WAS the clock. A
    // returning browser now has an identity with time already gone, and a page
    // that rendered 「2:00」 off `granted_ms` would be counting down a number that
    // is not the one the server will enforce — a status word that cannot say why
    // it is right (R11). An older page ignores this field and is no worse off
    // than it is today; it just cannot show the true remainder.
    remaining_ms: claimed.remainingMs,
  });
}
