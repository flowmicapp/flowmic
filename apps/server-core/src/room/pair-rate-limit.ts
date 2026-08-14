// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (mobile:pair short_code union)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure — a throttled
//     attempt returns an explicit whitelisted code, PAIR_RATE_LIMITED)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R23-1 (ruling 4: executor proposes the
//     thresholds; state is IN-MEMORY ONLY — 0.1.0 single instance, no DB/schema)
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth) — reviewable in isolation ***
//
// A 4-digit pairing code lives in a space of only 10^4 = 10,000 values, and the
// ShortCodeGovernor keeps a code ACTIVE for 5 minutes. Unthrottled, an attacker
// who can reach the socket can spray mobile:pair{short_code} guesses: at ~1,000
// attempts/s the expected time to hit the single active code is ~5 s — far
// inside the 5-min window, so the code is effectively cracked instantly.
//
// This governor keeps two in-memory tables (no DB, no schema — the pairing state
// that matters is transient). 🔴 They are NOT two halves of one control. Only the
// second one bounds an attacker; the first is a per-connection courtesy:
//
//   1. Per-socket exponential backoff. ⚠️ ATTEMPT and FAILURE are two different
//      counts, and this paragraph used to blur them: it said "the first 5
//      consecutive misses are free … from the 5th miss on, the socket is
//      locked", which cannot both be true of one counter. Stated precisely, and
//      MEASURED rather than reasoned: `check()` is called BEFORE each attempt,
//      and `recordFailure()` increments first and then arms the lock at
//      `failures >= freeAttempts` — so ATTEMPTS 1..5 are all allowed, the 5th
//      FAILURE arms the lock, and the 6th ATTEMPT is the first one refused, for
//      base·2^(excess) ms, capped at 30 s. In other words
//      PAIR_SOCKET_FREE_ATTEMPTS is a budget of ATTEMPTS (5 of them), not the
//      ordinal of the attempt that gets turned away. A SUCCESS resets the socket
//      — a paired phone is never punished for a neighbour's typo.
//      Pinned by pair-rate-limit.test.ts, "locks the socket with exponential
//      backoff after the free budget": it asserts `allowed` on each of the 5
//      attempts and then `retryAfterMs === PAIR_SOCKET_BACKOFF_BASE_MS`.
//      🔴 The constants did NOT move when this wording was fixed. If you are
//      reading this because a report said "only 4 attempts are free" — that
//      report was measuring the wording, not the limiter.
//      🔴 IT IS NOT A SECURITY BOUNDARY, and must never be sized or tuned as if
//      it were. Anyone who can reconnect clears it for free: the disconnect edge
//      deletes the entry outright (grep `pairLimiter.forget` →
//      socket/handlers/mobile.handler.ts) and the reconnect arrives with a
//      brand-new socket.id, i.e. a brand-new entry, regardless of anything this
//      table does. MEASURED with axis 2 disabled: 100 guesses, a fresh socket id
//      each, 100/100 allowed — pair-rate-limit.test.ts, "IT-25 the sockets table
//      is NOT the attacker bound — the per-IP window is".
//      ⚠️ That title is quoted VERBATIM. It previously read "not an attacker
//      bound", which matched no test in the repo: the citation was a paraphrase,
//      and a paraphrased citation is unfalsifiable by grep — which is the whole
//      job a citation has in this file (anti-façade ④).
//
//   2. Per-IP sliding window — THE bound. A host is capped at 10 failures per
//      rolling 60 s; beyond that every attempt from that IP is rejected until the
//      window drains. MEASURED on the same 100-guess spray, with axis 1 fully
//      bypassed by socket rotation: exactly 10/100 allowed — same test as axis 1
//      above, "IT-25 the sockets table is NOT the attacker bound — the per-IP
//      window is", whose second half asserts exactly PAIR_IP_MAX_FAILURES.
//      `recordFailure`
//      stamps this layer UNCONDITIONALLY — including on the one path where axis 1
//      declines to record (see PAIR_SOCKET_MAX_KEYS) — so it is never the layer
//      that goes missing.
//
// Brute-force math WITH the caps: one IP is bounded to ≈10 misses / 60 s ⇒ ≈50
// misses over a 5-min code lifetime ⇒ P(hit within one code's life) ≈ 50/10⁴ =
// 0.5 %. Each rotated code is an independent 0.5 % trial, so cracking is a
// geometric process with mean ≈200 code-lifetimes (~16 h of sustained spray),
// while a legit user typing a code once — or fumbling it a couple of times — is
// never affected. Success resets, so a real pairing is untouched.
// ⚠️ Note which term is absent: axis 1 appears nowhere in that derivation. That
// is not an omission — it is the same point in arithmetic form.
//
// ⚠️ Clock. Every deadline here is wall-clock `Date.now()`. A BACKWARD step (NTP
// correction, VM resume) stretches live socket locks and holds IP windows open
// past 60 s; a FORWARD step releases locks early and drains IP windows wholesale
// — forward is the direction that loses limiting. Pre-existing; deliberately NOT
// re-architected onto a monotonic clock here. Recorded so the next reader does
// not have to rediscover which way it fails open.

import { log } from '../log';

/** After this many consecutive per-socket misses, backoff kicks in. */
export const PAIR_SOCKET_FREE_ATTEMPTS = 5;
/** First backoff step (at the free-limit miss), doubled per further miss. */
export const PAIR_SOCKET_BACKOFF_BASE_MS = 1_000;
/** Backoff ceiling — a locked socket never waits longer than this. */
export const PAIR_SOCKET_BACKOFF_CAP_MS = 30_000;
/** Distinct sockets tracked at once — one entry per socket that has ever
 *  incurred a failed pair attempt and has not since re-paired or
 *  disconnected (see the `sockets` field below). Bounded so THIS table
 *  cannot be an unbounded-growth surface reachable by an unauthenticated
 *  caller: opening a socket.io connection and firing one bad guess costs
 *  nothing, so without a cap this Map grows one entry per attempt forever.
 *
 *  🔴 Memory is the ENTIRE job of this constant. This table is not an
 *  anti-attacker control and capping it did not make it one — see axis 1 in
 *  the file header: one reconnect resets a socket's state for free.
 *
 *  This reuses only HALF of the IT-08 shape (grep DIAG_MAX_KEYS in
 *  diag-routes.ts for the canonical site: DiagUploadThrottle). The cap and
 *  "only touch eviction when a NEW key needs a slot" timing match; the
 *  EVICTION VICTIM does not.
 *
 *  Why the victim differs — on honest grounds, not a threat model. Unlike
 *  the IP table (self-expiring accounting that ages out on its own), an
 *  entry here can be serving a LIVE backoff lock: a refusal this limiter is
 *  issuing RIGHT NOW to a still-connected socket. Evicting that entry would
 *  make the table's housekeeping retract the limiter's own current answer.
 *  Skipping it costs one loop step, and there is always either a cheaper
 *  victim or no victim at all — so we fail toward KEEPING state.
 *  `evictOneUnlockedSocket` therefore takes only an entry whose lock has
 *  already elapsed (`now >= lockedUntil`), oldest such entry first.
 *
 *  🔴 THE GUARANTEE, EXACTLY: a live lock is never cut short. Nothing more.
 *
 *  🔴 WHAT IS NOT GUARANTEED — measured, not theorised: the ESCALATION
 *  LADDER is destructible. The predicate protects `lockedUntil`; the next
 *  backoff step is computed from `failures`, and once a lock has elapsed the
 *  entry is an ordinary eviction candidate that leaves carrying its whole
 *  accumulated count. MEASURED (pair-rate-limit.test.ts, "RESIDUAL"): an
 *  entry escalated to the 30 s cap, its lock allowed to elapse, then flooded
 *  out of the table, returns with next lock = 0 ms and its free attempts
 *  restored; a control run without the flood re-arms at 30 s.
 *
 *  🔴 Do NOT read that residual as the attack. An earlier version of this
 *  comment argued that lock-aware eviction stopped an attacker from
 *  "spraying a few hundred throwaway sockets" to unlock a socket. That
 *  premise is false and the production caller eight lines from the spray
 *  refutes it: the disconnect edge already deletes the entry (grep
 *  `pairLimiter.forget` → mobile.handler.ts), so the reset costs ONE
 *  reconnect, not hundreds of sockets. anti-façade ④ — a comment that says
 *  "because somewhere does X" must have that somewhere survive a grep, and
 *  this one was refuted by it. The policy stays because failing toward
 *  keeping state is right; it never closed a hole.
 *
 *  If the table is full and EVERY tracked socket is under a live lock, the
 *  newcomer's failure is not recorded at this layer. That does NOT un-throttle
 *  it: `recordFailure` stamps the per-IP window unconditionally (measured — the
 *  IP layer still refuses after exactly PAIR_IP_MAX_FAILURES while the socket
 *  layer is saturated). And the drop is no longer silent: it increments
 *  `droppedFailureCount` and emits one rate-budgeted warning
 *  (PAIR_SOCKET_DROP_WARN_MS). Pinned by pair-rate-limit.test.ts. */
export const PAIR_SOCKET_MAX_KEYS = 512;
/** Budget for the sockets-table saturation warning: at most ONE line per this
 *  many ms, however many failures are dropped in between. Same idiom as
 *  DiagUploadThrottle.shouldWarnOnceForWindow (grep it in diag-routes.ts), for
 *  the same reason commit 2da57f0 exists — a refusal that logs per request turns
 *  a flood into disk work, which is the amplifier we already removed once. The
 *  magnitude is not lost to the budget: every line carries both the count since
 *  the previous line and the running total. */
export const PAIR_SOCKET_DROP_WARN_MS = 60_000;
/** Per-IP sliding window length. */
export const PAIR_IP_WINDOW_MS = 60_000;
/** Max failed attempts per IP within the window before the IP is rejected.
 *  🔴 THIS NUMBER IS THE BRUTE-FORCE BOUND — the only one. The per-socket
 *  backoff above is a per-connection courtesy that one reconnect clears (file
 *  header, axis 1; measured 100/100 allowed with this layer disabled and a fresh
 *  socket id per guess, exactly 10/100 with it live). So: raising this raises the
 *  guess rate against a 10,000-value code space one-for-one, and the header's
 *  0.5 %-per-code-lifetime math is computed from THIS constant and
 *  PAIR_IP_WINDOW_MS alone. Anyone tuning a number in this file for
 *  brute-force-resistance reasons wants this one; PAIR_SOCKET_* will not do it.
 *  The residual this bound does NOT claim to stop is IP rotation itself. */
export const PAIR_IP_MAX_FAILURES = 10;
/** Distinct IPs tracked at once. Bounded so THIS map cannot be a memory-
 *  exhaustion vector on its own — it is one of TWO independently-bounded
 *  tables in this file (see PAIR_SOCKET_MAX_KEYS above for the other), so
 *  neither comment should be read as covering the whole class by itself.
 *  Same insertion/sweep shape as DiagUploadThrottle's DIAG_MAX_KEYS
 *  (grep DIAG_MAX_KEYS in diag-routes.ts): sweep expired keys on every touch,
 *  then oldest-first eviction when a NEW key needs a slot. Unlike the
 *  socket table, ALWAYS evicting oldest-first is safe here specifically
 *  because a spent IP window is self-expiring accounting state, never an
 *  active punishment in progress.
 *
 *  Fail-safe direction: eviction FORGETS an IP's spent failure budget → that IP
 *  gets a FRESH budget if it returns. We deliberately choose this over "refuse
 *  new IPs when the table is full", which would let an attacker DoS every
 *  legitimate pairing host by filling the table with throwaway addresses (the
 *  failure would land on people who have never been seen before).
 *
 *  Residual (recorded honestly): an attacker who already exhausted IP A and can
 *  present ≥PAIR_IP_MAX_KEYS other source addresses can push A out of the Map
 *  and later reuse A with a clean window. That is NOT cheaper than simply using
 *  those other addresses (each already carries a full fresh budget) — so
 *  eviction-reset is not the cheap path. The cheap adversarial path remains IP
 *  rotation itself, which this bound does not claim to stop; it only stops
 *  unbounded Map growth. Pinned by pair-rate-limit.test.ts. */
export const PAIR_IP_MAX_KEYS = 512;

export interface PairRateLimitDecision {
  /** Whether a pair attempt may proceed right now. */
  allowed: boolean;
  /** When denied, ms the caller should wait before retrying (0 when allowed). */
  retryAfterMs: number;
}

export interface PairRateLimiterOptions {
  now?: () => number;
  socketFreeAttempts?: number;
  socketBackoffBaseMs?: number;
  socketBackoffCapMs?: number;
  ipWindowMs?: number;
  ipMaxFailures?: number;
  /** Override of PAIR_IP_MAX_KEYS — production leaves this unset. */
  maxKeys?: number;
  /** Override of PAIR_SOCKET_MAX_KEYS — production leaves this unset. */
  socketMaxKeys?: number;
  /** Sink for the saturation warning. Production leaves this unset and gets the
   *  REAL logger — never a friendly no-op default (docs/rebuild vol. 13 §7 F1
   *  ②: a DI default
   *  that silently succeeds is how a whole feature ends up never running). */
  warn?: (msg: string, fields?: Record<string, unknown>) => void;
}

interface SocketState {
  failures: number;
  lockedUntil: number;
}

export class PairRateLimiter {
  private readonly now: () => number;
  private readonly freeAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly ipWindowMs: number;
  private readonly ipMaxFailures: number;
  private readonly maxKeys: number;
  private readonly socketMaxKeys: number;
  private readonly warn: (msg: string, fields?: Record<string, unknown>) => void;

  private readonly sockets = new Map<string, SocketState>();
  private readonly ips = new Map<string, number[]>(); // ip → ascending failure ts

  /** Failures this limiter declined to record at the per-socket layer (table
   *  full, every entry live-locked). Monotonic, never reset — the whole reason
   *  it exists is that the state it counts used to leave no trace at all. */
  private drops = 0;
  /** Watermark + budget for the warning line (PAIR_SOCKET_DROP_WARN_MS).
   *  -Infinity, not 0, so the FIRST drop always warns even under an injected
   *  clock that starts at 0. */
  private dropsAtLastWarn = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(opts: PairRateLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.freeAttempts = opts.socketFreeAttempts ?? PAIR_SOCKET_FREE_ATTEMPTS;
    this.backoffBaseMs = opts.socketBackoffBaseMs ?? PAIR_SOCKET_BACKOFF_BASE_MS;
    this.backoffCapMs = opts.socketBackoffCapMs ?? PAIR_SOCKET_BACKOFF_CAP_MS;
    this.ipWindowMs = opts.ipWindowMs ?? PAIR_IP_WINDOW_MS;
    this.ipMaxFailures = opts.ipMaxFailures ?? PAIR_IP_MAX_FAILURES;
    this.maxKeys = opts.maxKeys ?? PAIR_IP_MAX_KEYS;
    this.socketMaxKeys = opts.socketMaxKeys ?? PAIR_SOCKET_MAX_KEYS;
    this.warn = opts.warn ?? log.warn;
  }

  /** TEST-ONLY: number of distinct sockets currently tracked. Exposed so
   *  PAIR_SOCKET_MAX_KEYS can be asserted directly (table size), not only
   *  inferred through side effects. */
  get socketTableSize(): number {
    return this.sockets.size;
  }

  /** How many failed attempts were declined at the per-socket layer because the
   *  table was full of live locks (see PAIR_SOCKET_MAX_KEYS). 0 in any normal
   *  deployment. NOT test-only: this is the standing evidence that the state was
   *  ever reached — the bounded warning is the push half, this is the pull half.
   *  (Structural-defect class #1 in this repo is a pushed state with nobody
   *  pulling; a counter nobody can read is the mirror image of it.) */
  get droppedFailureCount(): number {
    return this.drops;
  }

  /** May this socket/IP attempt a pair now? Pure read — call BEFORE pairing. */
  check(socketId: string, ip: string): PairRateLimitDecision {
    const now = this.now();
    const s = this.sockets.get(socketId);
    if (s && now < s.lockedUntil) {
      return { allowed: false, retryAfterMs: s.lockedUntil - now };
    }
    this.sweepExpiredIps(now);
    const window = this.ips.get(ip) ?? [];
    const oldest = window[0];
    if (oldest !== undefined && window.length >= this.ipMaxFailures) {
      // The oldest failure must age out before a slot frees.
      const retry = oldest + this.ipWindowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retry, 0) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Record a failed pair attempt (a code that did not resolve). */
  recordFailure(socketId: string, ip: string): void {
    const now = this.now();
    const existing = this.sockets.get(socketId);
    // A slot is available if: this socketId is already tracked (plain
    // update, map does not grow); there is room under the cap; or an
    // UNLOCKED victim can be evicted to make room (see PAIR_SOCKET_MAX_KEYS
    // doc comment — a LOCKED entry is never a candidate).
    const hasSlot =
      existing !== undefined ||
      this.sockets.size < this.socketMaxKeys ||
      this.evictOneUnlockedSocket(now);
    if (hasSlot) {
      const s = existing ?? { failures: 0, lockedUntil: 0 };
      s.failures += 1;
      if (s.failures >= this.freeAttempts) {
        const excess = s.failures - this.freeAttempts; // 0 at the free-limit miss
        const backoff = Math.min(this.backoffBaseMs * 2 ** excess, this.backoffCapMs);
        s.lockedUntil = now + backoff;
      }
      this.sockets.set(socketId, s);
    } else {
      // PAIR_SOCKET_MAX_KEYS reached and every tracked socket is under an active
      // lock right now — there is no entry that can be sacrificed without cutting
      // short a refusal in flight, so this failure is not recorded at the
      // per-socket layer. The socket is NOT un-throttled by that: the per-IP
      // window a few lines below is stamped unconditionally (measured — with this
      // layer saturated, the IP layer still refuses after exactly ipMaxFailures).
      //
      // What this branch must never be is INVISIBLE. It is a state the
      // previously-unbounded map could not reach, and a state that leaves no
      // evidence cannot be diagnosed after the fact — so it leaves both a
      // monotonic counter (pull) and a rate-budgeted warning (push).
      this.drops += 1;
      if (now - this.lastWarnAt >= PAIR_SOCKET_DROP_WARN_MS) {
        this.warn('pair_rate_limit.socket_table_saturated', {
          dropped_since_last_line: this.drops - this.dropsAtLastWarn,
          dropped_total: this.drops,
          tracked: this.sockets.size,
          max_keys: this.socketMaxKeys,
        });
        this.dropsAtLastWarn = this.drops;
        this.lastWarnAt = now;
      }
    }
    this.sweepExpiredIps(now);
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

  /** A pairing succeeded — reset this socket's backoff (never punish a real pair).
   *  The IP window is left to drain so an attacker cannot launder failures by
   *  interleaving one legitimate success. */
  recordSuccess(socketId: string): void {
    this.sockets.delete(socketId);
  }

  /** Drop a disconnected socket's state (called from the disconnect edge). */
  forget(socketId: string): void {
    this.sockets.delete(socketId);
  }

  /** Drop every IP whose window has fully aged out. Same role as the
   *  `t - w.start >= windowMs` loop in DiagUploadThrottle.take. */
  private sweepExpiredIps(now: number): void {
    const cutoff = now - this.ipWindowMs;
    for (const [ip, stamps] of this.ips) {
      const kept = stamps.filter((ts) => ts > cutoff);
      if (kept.length === 0) this.ips.delete(ip);
      else if (kept.length !== stamps.length) this.ips.set(ip, kept);
    }
  }

  /** Find and drop ONE socket entry that is not currently serving an active
   *  lock, oldest (insertion-order) first. Returns true if a slot was freed.
   *
   *  This predicate IS the entire guarantee this file makes about eviction:
   *  `now >= state.lockedUntil`, so an entry under a live lock is never taken
   *  and a refusal in flight is never cut short by the table making room.
   *  🔴 It protects the LOCK, not the `failures` ladder — a lapsed entry is an
   *  ordinary victim and leaves carrying its accumulated count (the measured
   *  residual documented on PAIR_SOCKET_MAX_KEYS). Do not restate it as more
   *  than that. Pinned, with a reverse control, by pair-rate-limit.test.ts. */
  private evictOneUnlockedSocket(now: number): boolean {
    for (const [id, state] of this.sockets) {
      if (now >= state.lockedUntil) {
        this.sockets.delete(id);
        return true;
      }
    }
    return false;
  }
}
