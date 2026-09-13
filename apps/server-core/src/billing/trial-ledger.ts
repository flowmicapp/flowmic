// SPEC-REF:
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.3 (「首次
//     120 s；同「匿名身份 + IP 桶」24 h 窗内第二次 60、第三次 30、之后 0」, owner
//     ruling W-2 of 2026-09-06 — the numbers are owner's and this file does not
//     invent one), §3.1 gates 4 and 5
//   ../db/schema-trial.ts (why the table has no `ms_used` column)
//   ../db/repos/trial-ledger.repo.ts (rows in, rows out; no policy there)
//   *** HUMAN-AUDIT SENSITIVE (billing) ***
//
// 「How long may THIS visitor speak, and do they already have an identity」 — the
// unregistered half of the quota question, in the one place that answers it.
//
// ── ONE LIFETIME 120 s PER BROWSER IDENTITY ────────────────────
// owner §10 replaced a per-network daily sequence (120 → 60 → 30 → 0) with a
// per-browser lifetime grant. The three differences are worth spelling out
// because each of them is a thing this file used to do and must not:
//
//   · THE KEY IS THE BROWSER, NOT THE NETWORK. `device_uid` — the `wb-…` value
//     the web client keeps in localStorage — decides which row a claim lands on.
//     An IP bucket now only feeds the abuse caps in http/web-anon-routes.ts.
//   · THERE IS NO RESET. No day is consulted when a grant is chosen, so a spent
//     trial is still spent tomorrow. `resets_at` on the wire is null, and that
//     is honest rather than a placeholder (billing/budget-push.ts).
//   · A RETURNING BROWSER IS NOT A NEW VISITOR. `claim` finds the existing row
//     and hands back what is LEFT of the one 120 s; only a uid this table has
//     never seen mints anything.
//
// 🔴 CLEARING SITE DATA BUYS ANOTHER 120 s, AND owner ACCEPTED THAT (§10:
// 「只要不清缓存」). It is written down rather than defended: the alternative is
// fingerprinting a visitor who has not signed in, which this product does not
// do, and the IP/global caps in http/web-anon-routes.ts are what keep the cost
// of that loop bounded. They are ABUSE ceilings, never an allowance — a request
// they let through still gets whatever this file says is left, which may be 0.
//
// ⚠️ THE 48-HOUR SWEEP IS NOW THE ONLY THING THAT ENDS A TRIAL. Since a row
// outlives its day, an identity swept as stale takes its 「spent」 with it and
// that browser can claim again. That is a REAL hole in 「one-time」, it is
// bounded by the sweep window, and it is stated here rather than behind a
// comment claiming the trial is permanent — widening that window is a change to
// the sweep and to this line together.
//
// ── 🔴 WHAT THIS FILE DOES NOT DO ────────────────────
// It never decides whether a request is allowed (that is the route's gate
// chain), never touches Turnstile, and never reads an Origin.

import { planLimits, type PlanLimits } from './plans';
import type { TrialLedgerRepo } from '../db/repos/trial-ledger.repo';
import type { UserRepo } from '../db/repos/user.repo';
import { utcDay } from '../site/sanitize';

/**
 * owner §10 (2026-09-11), verbatim: 「2 分钟」 — once, for the lifetime of a
 * browser identity.
 *
 * 🔴 A SCALAR AND NOT A TABLE, AND THE SHAPE IS THE RULING. The array it
 * replaced (`TRIAL_GRANT_MS_SEQUENCE`, 120/60/30/0) made 「how long may this
 * visitor speak」 depend on who else had been on their network that day; a
 * lifetime grant cannot, so there is nothing left to index into. Anyone
 * reintroducing a second number here is reintroducing the reset owner removed.
 */
export const TRIAL_LIFETIME_GRANT_MS = 120_000;

/**
 * What an anonymous identity's `effectiveLimits` answers. The argument is the
 * LIFETIME grant frozen on the row; what is LEFT of it is the quota guard's
 * subtraction against `usage_records`, here as for every other principal.
 *
 * 🔴 ONLY `stt_minutes` IS THE TRIAL'S OWN NUMBER. Every other cell is free's,
 * copied through `planLimits('free')` rather than invented here, and the reason
 * is the capability-wall red line: `pcs` and `mobiles` are enforced by
 * room/registry.ts, so a tighter number would refuse the demo's own second
 * device with a message about a subscription the visitor never bought. `llm_tokens`
 * is a safety valve measured in a month's worth of talking — a two-minute demo
 * cannot approach it, and cutting it down would only create a way for the demo to
 * fail that nobody could explain.
 *
 * `stt_minutes` is REAL (usage_records.stt_minutes is a REAL column), so a 30 s
 * grant is 0.5 and not a rounded 0 or 1.
 */
export function trialLimitsFrom(grantedMs: number): PlanLimits {
  const ms = Number.isFinite(grantedMs) ? Math.max(0, grantedMs) : 0;
  return { ...planLimits('free'), stt_minutes: ms / 60_000 };
}

/** What `BillingService` needs from this module and nothing more. */
export interface TrialGrantReader {
  /** Milliseconds granted to this anonymous identity, or 0 if it has no row
   *  (a swept identity whose users row somehow survived: no grant, not a free
   *  month). */
  grantedMsFor(anonUserId: string): number;
}

export interface TrialClaimOutcome {
  userId: string;
  /** A LIVE credential either way: minted with the row, or rotated onto a
   *  returning one (whose predecessor's hour is long gone). */
  token: string;
  /** The LIFETIME allowance on the row — the same number `effectiveLimits`
   *  enforces. A reuse does not change it. */
  grantedMs: number;
  /** Milliseconds this identity has already spent, off `usage_records` — the
   *  one meter. 0 for a fresh mint. */
  usedMs: number;
  /** `grantedMs - usedMs`, floored at 0: what a page may render a clock for
   *  before any socket exists. */
  remainingMs: number;
  /** Forensic: identities this IP bucket had minted today. 0 on a reuse, because
   *  nothing was minted. */
  grantsUsedToday: number;
  expiresAtMs: number;
  /** FALSE only for a uid this table had never seen. The one thing a caller must
   *  not do is treat a reuse as a new visitor. */
  reused: boolean;
}

export interface TrialLedger extends TrialGrantReader {
  /** Identities this bucket has minted today. */
  bucketCountToday(ipBucket: string, nowMs: number): number;
  /** Milliseconds handed out site-wide today. */
  msGrantedToday(nowMs: number): number;
  /** Milliseconds actually spent site-wide today, off `usage_records`. */
  msUsedToday(nowMs: number): number;
  /** Demo rooms that are live at `nowMs` — the ceiling that bounds sockets and
   *  the 4-digit code space, not a money one. */
  liveRooms(nowMs: number): number;
  /**
   * The identity this browser should speak under — reused when it already has
   * one, minted when it does not. owner §10.
   *
   * 🔴 IT IS NOT CALLED `mint`, AND THE RENAME IS THE POINT. Both production
   * callers could read their own line as 「a new visitor arrives」; under owner
   * §10 that is true of exactly one call in a browser's life, and a verb saying
   * 「mint」 on the others is the sentence that would let a second 120 s back in.
   * The rename forced every call site to be reopened, which is how this change
   * of meaning got reviewed rather than assumed.
   *
   * `deviceUid` null or empty ⇒ ALWAYS A FRESH MINT, because nothing was
   * declared to remember the visitor by. That is a real degradation (an older
   * web build would collect 120 s on every visit) and the route's IP/global caps
   * are what bound it. It is NOT a refusal: refusing would take the demo away
   * from every client that has not shipped the field yet, and to a visitor that
   * failure would look exactly like the product being broken.
   *
   * The caller has already decided the request is allowed; this only reads and
   * writes. `newId` / `newToken` are injected so the two ids come from the same
   * generators the rest of the server uses rather than from a second one here.
   */
  claim(input: {
    /** The `wb-…` browser identity, or null when the caller declared none. */
    deviceUid: string | null;
    ipBucket: string;
    nowMs: number;
    tokenTtlMs: number;
    newId(): string;
    newToken(): string;
  }): TrialClaimOutcome;
  /** The identity a live token names, or null when the token is unknown OR its
   *  hour is up. The two are one answer ON PURPOSE at this seam: the caller
   *  refuses identically either way, and telling them apart on the wire would
   *  tell a prober whether a token ever existed. */
  resolveToken(token: string, nowMs: number): { userId: string; grantedMs: number } | null;
}

export function makeTrialLedger(deps: {
  rows: TrialLedgerRepo;
  users: Pick<UserRepo, 'insert'>;
}): TrialLedger {
  return {
    grantedMsFor(anonUserId): number {
      return deps.rows.findByUser(anonUserId)?.ms_granted ?? 0;
    },
    bucketCountToday(ipBucket, nowMs): number {
      return deps.rows.countForBucket(ipBucket, utcDay(nowMs));
    },
    msGrantedToday(nowMs): number {
      return deps.rows.msGrantedOn(utcDay(nowMs));
    },
    msUsedToday(nowMs): number {
      return deps.rows.msUsedOn(utcDay(nowMs));
    },
    liveRooms(nowMs): number {
      return deps.rows.countLiveRooms(new Date(nowMs).toISOString());
    },
    claim(input): TrialClaimOutcome {
      const uid = typeof input.deviceUid === 'string' ? input.deviceUid.trim() : '';
      const expiresAtMs = input.nowMs + input.tokenTtlMs;
      // ── DOES THIS BROWSER ALREADY HAVE ONE ──────────────────────
      // 🔴 THERE IS NO DAY IN THIS LOOKUP, AND THAT ABSENCE IS owner §10. The
      // moment a `day` appears here, every spent trial re-opens at midnight —
      // which is precisely the behaviour the ruling replaced.
      const existing = uid === '' ? null : deps.rows.findByDeviceUid(uid);
      if (existing) {
        // A fresh credential, and NOTHING else. `ms_granted` is written once, at
        // mint; rewriting it here is the one way a second 120 s could be handed
        // out, so it is not written here at all.
        const token = input.newToken();
        deps.rows.refreshToken(existing.anon_user_id, token, expiresAtMs);
        const usedMs = deps.rows.msUsedByUser(existing.anon_user_id);
        return {
          userId: existing.anon_user_id,
          token,
          grantedMs: existing.ms_granted,
          usedMs,
          remainingMs: Math.max(0, existing.ms_granted - usedMs),
          grantsUsedToday: 0,
          expiresAtMs,
          reused: true,
        };
      }
      // ── A UID THIS TABLE HAS NEVER SEEN ────────────────────────
      // The lookup above and the two inserts below are SYNCHRONOUS in one
      // process (node:sqlite), and only a writer node reaches this branch
      // (`WebTrialDecisionInput.mayMint`; the HTTP demo arm is writer-only), so
      // there is no interleaving for a check-then-act to lose to. The partial
      // unique index remains the guard of record — it is what makes that claim
      // falsifiable rather than merely asserted.
      const day = utcDay(input.nowMs);
      // Forensic only now (schema-trial.ts): it records how busy this network
      // was when the visitor arrived, and no longer picks anybody's grant.
      const grantsUsedToday = deps.rows.countForBucket(input.ipBucket, day);
      const grantedMs = TRIAL_LIFETIME_GRANT_MS;
      const userId = input.newId();
      const token = input.newToken();
      // The users row FIRST: the ledger row carries a foreign key to it, so the
      // other order would be a write that can only fail.
      // No `display_name`: the column's own default applies. Nothing renders it
      // on this path (a phone's top bar shows the ROOM's name,
      // room/web-room.ts WEB_ROOM_PC_NAME), and inventing a word here would be a
      // new user-visible string in one language for a nine-language product.
      deps.users.insert({ id: userId, anonymous: true });
      deps.rows.insert({
        anon_user_id: userId,
        ip_bucket: input.ipBucket,
        day,
        grants_used: grantsUsedToday,
        ms_granted: grantedMs,
        anon_token: token,
        token_expires_at: expiresAtMs,
        created_at: new Date(input.nowMs).toISOString(),
        device_uid: uid === '' ? null : uid,
      });
      return {
        userId, token, grantedMs, usedMs: 0, remainingMs: grantedMs,
        grantsUsedToday, expiresAtMs, reused: false,
      };
    },
    resolveToken(token, nowMs): { userId: string; grantedMs: number } | null {
      const row = deps.rows.findByToken(token);
      if (row === null || row.token_expires_at <= nowMs) return null;
      return { userId: row.anon_user_id, grantedMs: row.ms_granted };
    },
  };
}
