// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 / error-codes REGISTER_RATE_LIMITED
//     (F-2327 SB-3: per-IP registration throttle — a throwaway-account farm mints
//     unbounded free quota)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-1 ② (per-IP 5/10min on
//     /api/register AND /api/login)
//   docs/rebuild/13-LESSONS-LEARNED.md §6.4 (XFF/trusted-proxy semantics are
//     re-validated at the Cloudflare-fronting stage — DEFERRED here; the private
//     0.1.0 keys on the DIRECT peer address, never a spoofable XFF header)
//   *** HUMAN-AUDIT SENSITIVE (auth/rate-limit) — reviewable in isolation ***
//
// A pure per-IP sliding-window counter, in-memory only (0.1.0 single instance —
// no DB/schema, same rationale as room/pair-rate-limit.ts). check() is a pure
// read; record() stamps one attempt. Shared by REST register + login: an honest,
// distinct REGISTER_RATE_LIMITED (429) — never a silent drop.

import { log } from '../log';

/** Rolling window length. */
export const REGISTER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
/** Max attempts per IP within the window before further attempts are rejected. */
export const REGISTER_MAX_ATTEMPTS = 5;
/** Distinct IPs tracked at once. Bounded so the table itself cannot be the
 *  memory-exhaustion vector. Same shape as DiagUploadThrottle's DIAG_MAX_KEYS
 *  (grep DIAG_MAX_KEYS in diag-routes.ts): sweep expired keys on every touch,
 *  then oldest-first eviction when a NEW key needs a slot.
 *
 *  Fail-safe direction: eviction FORGETS an IP's spent budget → that IP gets a
 *  FRESH budget if it returns. We deliberately choose this over "refuse new IPs
 *  when the table is full", which would let an attacker DoS every legitimate
 *  registrant by filling the table with throwaway addresses (the failure would
 *  land on people who have never been seen before).
 *
 *  Residual (recorded honestly): an attacker who already exhausted IP A and can
 *  present ≥REGISTER_IP_MAX_KEYS other source addresses can push A out of the
 *  Map and later reuse A with a clean window. That is NOT cheaper than simply
 *  using those other addresses (each already carries a full fresh budget) — so
 *  eviction-reset is not the cheap path. The cheap adversarial path remains IP
 *  rotation itself, which this bound does not claim to stop; it only stops
 *  unbounded Map growth. Pinned by register-rate-limit.test.ts. */
export const REGISTER_IP_MAX_KEYS = 512;

/**
 * NR-2a item 3 (i) — the DAILY per-IP cap on ACCOUNT CREATION.
 *
 * SPEC-REF: docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 3
 *   (owner, verbatim: 「会不会出现狂刷邮箱来套取免费额度的情况，因为免费额度对于
 *   运营者来说也是有成本的」)
 *
 * 🔴 WHY THE EXISTING 5/10-MIN LIMITER DOES NOT ALREADY ANSWER THIS, which is
 * the whole reason a second window exists. That one is a BURST brake: it stops
 * a script from hammering the route. It does not stop patience. Five accounts
 * every ten minutes, sustained, is 720 accounts a day from one address — each
 * with its own free managed-STT allowance — and every single request is inside
 * the limit. A sliding window can only ever bound the RATE; the cost owner is
 * worried about is bounded by the TOTAL.
 *
 * 🔴 AND WHY IT IS A SEPARATE COUNTER RATHER THAN A LONGER WINDOW ON THE
 * EXISTING ONE. The 5/10-min bucket is shared by register AND login (and, since
 * NR-1, the Google arm). Widening it would make failed sign-ins consume the
 * account-creation budget and vice-versa — one value answering two questions,
 * and the visible symptom would be an office NAT unable to log in because
 * somebody there created accounts this morning. This counter is spent ONLY when
 * an account is really minted.
 *
 * 🔴 2 IS AN OWNER NUMBER, NOT OURS —
 * docs/decisions/2026-08-27-owner-web-rulings-batch-2.md item 4, verbatim:
 * 「同一 IP 或同一来源指纹（需要思考如何获取）每天最多注册 2 个账号」.
 *
 * ⚠️ THE FIRST-RESPONSIBLE PROPOSAL WAS 10, AND ITS ARGUMENT IS KEPT because
 * it names the direction this number can be wrong in and the owner overrode it
 * knowingly: 「a shared office/campus NAT plausibly produces a handful of
 * genuine sign-ups in a day and implausibly produces eleven」. At 2 that trade
 * moves: a household, a co-working space or a company behind one NAT reaches
 * the cap on the THIRD genuine sign-up of the day and is told to come back
 * tomorrow. That cost is real, it is accepted, and it is the reason this
 * paragraph exists rather than a comment claiming 2 is obviously safe.
 *
 * ⚠️ THE SECOND HALF OF THE OWNER'S SENTENCE IS NOT IMPLEMENTED, ON PURPOSE.
 * 「同一来源指纹」 — a source fingerprint — is marked in the ruling itself as
 * 「需要思考如何获取」 (still to be worked out) and carries a flag that it sits
 * next to published promises in docs/legal/privacy-policy.md (no tracker, no
 * advertising identifier). It is RECORDED THERE AND BUILT NOWHERE: this cap is
 * keyed on the IP alone. Anyone adding a fingerprint dimension here has a legal
 * review to do first, and that review is an owner decision, not a code change.
 *
 * ⚠️ WHAT IT DELIBERATELY IS NOT. It is a floor, not a defence: IP rotation
 * defeats it, exactly as it defeats the burst limiter, and nothing here claims
 * otherwise — that is precisely the hole the GLOBAL surge gate
 * (auth/registration-surge.ts) exists to cover, because a counter that does not
 * care which address a mint came from cannot be rotated away from. What makes
 * this one worth having anyway is the pair: a cap that raises the price, and
 * the `auth: account minted` log line that makes the bill visible.
 */
export const REGISTER_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REGISTER_MAX_PER_DAY = 2;

/**
 * Resolve the daily cap in force on this process.
 *
 * ── ENVIRONMENT ────────────────────────────────────────────────────────────
 *   FLOWMIC_REGISTER_DAILY_CAP — optional positive-integer override of
 *     {@link REGISTER_MAX_PER_DAY}.
 *
 * 🔴 THE DEFAULT IS THE OWNER'S 2 AND STAYS THE OWNER'S 2. This function does
 * not soften the ruling; it gives a NON-PRODUCTION harness a way to reach a
 * state the ruling makes unreachable, which is a different thing.
 *
 * ⚠️ WHY IT HAD TO EXIST, recorded because it is the kind of fact that gets
 * rediscovered as a mystery. The golden-path suite dials LOOPBACK, so every
 * account it creates in one run shares ONE address bucket, and several of its
 * cases mint three or more accounts by design (a billing chain needs an exempt
 * account, a mapped one and an unmapped one to have anything to compare). At a
 * cap of 2 those cases stop being able to set up their own fixture — the
 * product is right and the harness is stuck. The alternatives were both worse:
 * exempting loopback IN PRODUCT CODE would put a bypass in the shipped binary
 * that nobody exercises and everybody trusts (and behind nginx every peer IS
 * loopback — the exact shape fix-010 already cost us once), and weakening the
 * default would answer a test problem by changing what users get.
 *
 * A junk or non-positive value falls back to the ruled default and SAYS SO —
 * it never disables the cap. An operator's typo must not be able to turn off
 * the thing that bounds a bill, which is the same rule (and the same failure
 * direction) `resolveRegistrationSurgeGate` states for its own threshold.
 *
 * ⚠️ NO BOOT LINE HERE, deliberately, unlike the surge gate's. This value is
 * already reported on every refusal it causes (`auth: account creation refused`
 * carries the budget), and the surge gate's boot line exists because its state
 * is otherwise INVISIBLE until an attack. Announcing a number that already
 * announces itself would be a second copy that can disagree.
 */
export function resolveRegisterDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.FLOWMIC_REGISTER_DAILY_CAP ?? '').trim();
  if (raw === '') return REGISTER_MAX_PER_DAY;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  log.error('auth: FLOWMIC_REGISTER_DAILY_CAP is not a positive integer — keeping the owner-ruled default', {
    env: 'FLOWMIC_REGISTER_DAILY_CAP',
    value: raw,
    cap: REGISTER_MAX_PER_DAY,
  });
  return REGISTER_MAX_PER_DAY;
}

export interface RegisterRateLimitDecision {
  allowed: boolean;
  /** When denied, ms to wait before a slot frees (0 when allowed). */
  retryAfterMs: number;
}

export interface RegisterRateLimiterOptions {
  now?: () => number;
  windowMs?: number;
  maxAttempts?: number;
  /** Override of REGISTER_IP_MAX_KEYS — production leaves this unset. */
  maxKeys?: number;
}

export class RegisterRateLimiter {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly maxKeys: number;
  private readonly ips = new Map<string, number[]>(); // ip → ascending attempt ts

  constructor(opts: RegisterRateLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? REGISTER_WINDOW_MS;
    this.maxAttempts = opts.maxAttempts ?? REGISTER_MAX_ATTEMPTS;
    this.maxKeys = opts.maxKeys ?? REGISTER_IP_MAX_KEYS;
  }

  /** May this IP attempt now? Pure read — call BEFORE processing. */
  check(ip: string): RegisterRateLimitDecision {
    const now = this.now();
    this.sweepExpired(now);
    const window = this.ips.get(ip) ?? [];
    const oldest = window[0];
    if (oldest !== undefined && window.length >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: Math.max(oldest + this.windowMs - now, 0) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Stamp one attempt (register or login) against the IP window. */
  record(ip: string): void {
    const now = this.now();
    this.sweepExpired(now);
    let window = this.ips.get(ip);
    if (!window) {
      // Mirror DiagUploadThrottle.take (diag-routes.ts): only when inserting a
      // NEW key, and only by dropping the oldest — never by refusing the newcomer.
      if (this.ips.size >= this.maxKeys) {
        const oldest = this.ips.keys().next();
        if (!oldest.done) this.ips.delete(oldest.value);
      }
      window = [];
    }
    window.push(now);
    this.ips.set(ip, window);
  }

  /** Drop every IP whose window has fully aged out. Same role as the
   *  `t - w.start >= windowMs` loop in DiagUploadThrottle.take. */
  private sweepExpired(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [ip, stamps] of this.ips) {
      const kept = stamps.filter((ts) => ts > cutoff);
      if (kept.length === 0) this.ips.delete(ip);
      else if (kept.length !== stamps.length) this.ips.set(ip, kept);
    }
  }
}

/**
 * NR-2a — every per-IP bucket the account layer uses, built in one place.
 *
 * 🔴 WHY THEY MOVED OUT OF bootstrap.ts. There are five of them now and the
 * ONLY thing a reader needs from the wiring root is that they are five separate
 * budgets. The argument for each separation — and it is a different argument
 * each time — belongs beside the counter it separates, which is here. That is
 * the same structural split password-reset-routes.ts made out of
 * console-routes.ts, and it deletes no evidence: every comment travelled.
 *
 * 🔴 SEPARATE INSTANCES, NOT SEPARATE KEYS IN ONE MAP. Sharing a bucket makes
 * one counter answer two questions, and the visible symptom is always the same
 * shape: an office NAT that cannot sign in because somebody there did something
 * else this morning.
 *   · `register`         — register + login + the Google arm share ONE burst
 *                          brake (5 / 10 min). They are all 「present a
 *                          credential」, so one budget is the honest grouping;
 *   · `siteAnalytics`    — the landing-page collect route (120 / min). A scrape
 *                          of a public page must not lock out registration;
 *   · `password`         — the reset surface. A reset flood must not starve a
 *                          login budget, and vice-versa;
 *   · `accountMint`      — the DAILY cap on real account mints (see
 *                          REGISTER_MAX_PER_DAY above for why a rate limit
 *                          cannot bound a total);
 *   · `verificationLink` — the anonymous one-click confirm route. A burst of
 *                          link clicks must not lock anyone out of signing in.
 */
export interface AuthRateLimiters {
  register: RegisterRateLimiter;
  siteAnalytics: RegisterRateLimiter;
  password: RegisterRateLimiter;
  accountMint: RegisterRateLimiter;
  verificationLink: RegisterRateLimiter;
}

export function makeAuthRateLimiters(now?: () => number, env: NodeJS.ProcessEnv = process.env): AuthRateLimiters {
  const clock = now ? { now } : {};
  return {
    register: new RegisterRateLimiter(clock),
    siteAnalytics: new RegisterRateLimiter({ ...clock, maxAttempts: 120, windowMs: 60_000 }),
    password: new RegisterRateLimiter(clock),
    accountMint: new RegisterRateLimiter({
      ...clock,
      windowMs: REGISTER_DAY_WINDOW_MS,
      // 🔴 THE ONLY BUDGET IN THIS FACTORY THAT READS THE ENVIRONMENT, and the
      // reason is written at `resolveRegisterDailyCap`: a loopback-dialling
      // harness cannot otherwise build a fixture that needs three accounts.
      // Unset ⇒ the owner-ruled REGISTER_MAX_PER_DAY, unchanged.
      maxAttempts: resolveRegisterDailyCap(env),
    }),
    verificationLink: new RegisterRateLimiter(clock),
  };
}
