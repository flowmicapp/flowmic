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
