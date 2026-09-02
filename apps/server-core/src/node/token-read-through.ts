// SPEC-REF:
//   apps/server-core/src/auth/middleware.ts        (the seam that calls this)
//   apps/server-core/src/node/token-rows.ts        (the rows and how they land)
//   apps/server-core/src/node/writer-client.ts     (resolveToken)
//   apps/server-core/src/http/node-routes.ts       (POST /api/node/resolve-token)
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-4
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// ── THE DEFECT (P0-①, measured 2026-08-31) ──────────────────────────────────
//
// `mobile:pair` is writer-only, so a brand-new `mobile_pairings` row is created
// on the writer. Nothing forwards it: no member of the ForwardedWrite union
// carries a pairing row, and the outbox kinds are usage/presence/home_node only.
// A replica learns about it through ONE mechanism — the 30-second whole-database
// pull (replica-puller.ts, PULL_INTERVAL_MS).
//
// So a phone that pairs and then immediately follows its PC to that PC's home
// node presents a perfectly valid token to a node that has never heard of it,
// and is refused AUTH_TOKEN_INVALID at the handshake for up to thirty seconds.
// The owner's report of it is 「exit and re-enter twice and it works」 — that is
// the pull period, not a client bug. `pc_devices` has the same gap whenever a PC
// re-selects a node it has not been on.
//
// ── WHAT THIS IS, AND THE THREE THINGS IT MUST NOT BECOME ───────────────────
//
// On a LOCAL MISS, and only on a node that has a writer client, ask the writer
// once, land the rows it returns, and let the caller redo its ordinary LOCAL
// lookup. Everything downstream then reads the rows from this database exactly
// as if the pull had already delivered them.
//
//  1. NOT A HANG. The writer call has its own short budget
//     (RESOLVE_TOKEN_TIMEOUT_MS) and every failure — unreachable, timeout,
//     unusable body, a row that will not land — resolves `false`, which is
//     today's refusal. A handshake never waits on a retry.
//  2. NOT AN AMPLIFIER. A token is shape-checked before it can cost a request,
//     identical concurrent asks share one flight, and the number of writer calls
//     per window is capped. An attacker spraying random 64-hex strings must not
//     be able to convert socket connections into load on the one node that can
//     write.
//  3. NOT PRESENT AT ALL on a single node. There is no writer client to build
//     this from, so bootstrap passes nothing and `authMiddleware` runs the code
//     it ran yesterday, on the same tick. Absence of the dependency IS the
//     guarantee — not an `if (role === 'replica')` somebody can get wrong.

import { isValidTokenShape } from '../auth/token';
import type { TokenResolution } from './token-rows';

/** Sliding window for the writer-call budget. */
export const READ_THROUGH_WINDOW_MS = 60_000;
/**
 * Writer calls allowed per window, across all tokens on this node.
 *
 * 🔴 DERIVED, not picked. A LEGITIMATE read-through costs exactly one call per
 * device, ever: the rows land locally and the next handshake from that phone is
 * a local hit. So the honest sizing question is 「how many devices can plausibly
 * arrive at one replica within a minute holding rows it does not have」 — a node
 * coming back after an outage, or a wave of phones following their PCs after a
 * node list change. 120/minute covers a wave of that size with room, while
 * bounding an attacker to 120 requests/minute at the writer however many sockets
 * they open.
 *
 * ⚠️ The failure direction when the budget is spent is TODAY'S BEHAVIOUR: the
 * handshake is refused and the client's own reconnect ladder brings it back a
 * rung later, into a window that has drained. A throttled legitimate device is
 * slow, never broken — which is why this may be sized conservatively.
 */
export const READ_THROUGH_MAX_CALLS_PER_WINDOW = 120;
/** At most one line per this many ms while the budget is spent. A refusal that
 *  logs per attempt turns a flood into disk work — the amplifier we have already
 *  removed once (pair-rate-limit.ts PAIR_SOCKET_DROP_WARN_MS, same idiom, same
 *  reason). Magnitude is not lost: every line carries both counts. */
export const READ_THROUGH_WARN_MS = 60_000;

export interface TokenReadThroughDeps {
  /** The writer half. Resolves rows, resolves `null` for a token the writer does
   *  not know, and REJECTS when nothing could be learned. The three must stay
   *  distinguishable here — collapsing reject into null is how a transient
   *  outage becomes a permanent 「this pairing does not exist」. */
  askWriter: (token: string) => Promise<TokenResolution | null>;
  /** Land the rows in this node's database. Throws if they will not land, and
   *  that throw must reach this module rather than be swallowed inside it —
   *  「admitted a socket whose rows are not actually there」 is the one outcome
   *  worse than the refusal being fixed. */
  apply: (rows: TokenResolution) => void;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
  windowMs?: number;
  maxCallsPerWindow?: number;
}

/**
 * 🔴 A11/F2-a (WP-8, 2026-09-02) — the fact `resolve()` used to collapse into a
 * single `false`, now named. Three DIFFERENT things could make a read-through
 * miss, and only one of them licenses `authMiddleware` answering
 * `AUTH_TOKEN_INVALID` (a claim strong enough that both the phone
 * (`mobile_reconnect_flow.dart`) and the desktop (`socket/pairing.rs`) delete
 * the credential over it):
 *
 *   · `'landed'` — the rows are now local; the caller's ordinary local lookup
 *     will find them.
 *   · `'writer-confirmed-absent'` — `askWriter` reached the writer and the
 *     writer itself does not know this token (`askAndApply`'s own words: "the
 *     writer IS the authority"). This is the ONLY outcome that is actually a
 *     statement about the credential.
 *   · `'unverifiable'` — nothing was learned either way: the writer was
 *     unreachable, the budget was already spent, or the writer answered but
 *     its rows would not land locally (a fault on THIS node, not evidence
 *     about the token). A caller that treats this the same as
 *     `'writer-confirmed-absent'` deletes a credential the user never
 *     revoked, on a node that simply could not check.
 */
export type TokenReadThroughOutcome = 'landed' | 'writer-confirmed-absent' | 'unverifiable';

export interface TokenReadThrough {
  /**
   * `true` ⇔ rows for this token are now in the LOCAL database and the caller
   * should redo its ordinary local lookup.
   *
   * 🔴 It returns a BOOLEAN and not the rows, on purpose. The caller must build
   * its AuthContext from the local read, through the same code path a local hit
   * takes — one author for 「what this token means」. Handing the rows back would
   * create a second path that agrees with the first only as long as nobody edits
   * one of them.
   *
   * NEVER rejects. Every failure is `false`, which is the pre-existing refusal.
   * ⚠️ Kept byte-for-byte for existing callers (`mobile.handler.ts`'s
   * `mobile:reconnect`) that only ever needed the yes/no answer; a caller
   * that needs to tell WHY it was `false` uses [resolveDetailed] instead —
   * both share the same budget and single-flight table, so calling one does
   * not spend a second writer call the other could have reused.
   */
  resolve(token: string): Promise<boolean>;
  /** The A11/F2-a tri-state form of [resolve] — see [TokenReadThroughOutcome].
   *  `authMiddleware` is the first consumer; new callers should prefer this
   *  over `resolve` so a future one does not have to relearn the distinction
   *  the hard way (a real sign-out on a healthy credential). */
  resolveDetailed(token: string): Promise<TokenReadThroughOutcome>;
  /** How many asks were turned away by the budget. Monotonic. The pull half of
   *  the push/pull pair — a counter nobody can read is the mirror image of this
   *  repo's #1 structural defect (a pushed state with no reader). */
  readonly throttledCount: number;
}

export function makeTokenReadThrough(deps: TokenReadThroughDeps): TokenReadThrough {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? READ_THROUGH_WINDOW_MS;
  const maxCalls = deps.maxCallsPerWindow ?? READ_THROUGH_MAX_CALLS_PER_WINDOW;

  /** Ascending timestamps of writer calls actually made. Same sliding-window
   *  shape as PairRateLimiter's per-IP table; one bucket, because the thing
   *  being protected is one writer and not one caller. */
  let calls: number[] = [];
  /** Token → the flight already in progress for it. THE single-flight table: a
   *  phone whose ladder fires two handshakes 200 ms apart, or a PC and its
   *  reconnect racing, must cost the writer ONE request and not two. Keyed to
   *  the DETAILED outcome so `resolve()` and `resolveDetailed()` can share one
   *  flight per token regardless of which one a caller asks first. */
  const inFlight = new Map<string, Promise<TokenReadThroughOutcome>>();
  let throttled = 0;
  let throttledAtLastWarn = 0;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  const budgetAvailable = (t: number): boolean => {
    const cutoff = t - windowMs;
    calls = calls.filter((ts) => ts > cutoff);
    return calls.length < maxCalls;
  };

  const noteThrottled = (t: number): void => {
    throttled += 1;
    if (t - lastWarnAt < READ_THROUGH_WARN_MS) return;
    deps.log.warn('node.token_read_through throttled — a valid token may be refused until the next replication pull', {
      throttled_since_last_line: throttled - throttledAtLastWarn,
      throttled_total: throttled,
      window_ms: windowMs,
      max_calls_per_window: maxCalls,
    });
    throttledAtLastWarn = throttled;
    lastWarnAt = t;
  };

  const askAndApply = async (token: string): Promise<TokenReadThroughOutcome> => {
    let rows: TokenResolution | null;
    try {
      rows = await deps.askWriter(token);
    } catch (err) {
      // Nothing is known. Refuse — which is what this node did before the route
      // existed — and say so as an outage, never as 「no such token」.
      deps.log.warn('node.token_read_through could not reach the writer — refusing as before', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'unverifiable';
    }
    // The writer IS the authority. A null here is the one case where a replica's
    // AUTH_TOKEN_INVALID is a statement about the product rather than about this
    // node's copy of the database.
    if (!rows) return 'writer-confirmed-absent';
    try {
      deps.apply(rows);
    } catch (err) {
      // A row that will not land (UNIQUE on a token held by a stale local row,
      // FK on a user this node has not pulled yet). Loud, because it is the one
      // failure here that is OURS rather than the network's, and it will keep
      // happening for this device until the next pull reconciles the table.
      // 'unverifiable', NOT 'writer-confirmed-absent': the writer just said
      // this token IS real. The fault is this node's inability to land it, and
      // deleting the credential over a local write error would blame the user
      // for a bug in our own replication.
      deps.log.warn('node.token_read_through resolved a token but could not land its rows', {
        kind: rows.kind,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'unverifiable';
    }
    deps.log.info('node.token_read_through landed rows ahead of the replication pull', {
      kind: rows.kind,
      pc_id: rows.pc.id,
    });
    return 'landed';
  };

  /** Shared by both public methods so a single flight (and a single writer
   *  call, and a single budget spend) serves whichever one a caller reaches
   *  for first, and a second caller racing the first. */
  const resolveDetailed = (token: string): Promise<TokenReadThroughOutcome> => {
    // 🔴 SHAPE FIRST, BEFORE ANYTHING ELSE COSTS ANYTHING. `authMiddleware`
    // already refuses a malformed token before it reaches a lookup, so in
    // production this is the second check — deliberately. This module is the
    // thing that turns an unauthenticated string into a request at the writer,
    // and it must not depend on a caller elsewhere having been careful.
    // A malformed token is 'unverifiable', not 'writer-confirmed-absent': this
    // node refused to even ASK, so nothing was learned about the writer's
    // opinion of it — `authMiddleware`'s OWN shape check ahead of this call is
    // what turns a malformed token into the permanent refusal in production.
    if (!isValidTokenShape(token)) return Promise.resolve('unverifiable');
    const existing = inFlight.get(token);
    if (existing) return existing;
    const t = now();
    if (!budgetAvailable(t)) {
      noteThrottled(t);
      return Promise.resolve('unverifiable');
    }
    calls.push(t);
    const flight = askAndApply(token).finally(() => {
      // Cleared on EVERY outcome and cleared unconditionally: a flight left in
      // this map would be a permanent cached answer for that token, and a
      // cached miss is a valid pairing that never recovers.
      inFlight.delete(token);
    });
    inFlight.set(token, flight);
    return flight;
  };

  return {
    get throttledCount(): number {
      return throttled;
    },
    resolveDetailed,
    resolve(token: string): Promise<boolean> {
      return resolveDetailed(token).then((outcome) => outcome === 'landed');
    },
  };
}
