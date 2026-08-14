// SPEC-REF:
//   docs/strategy/2026-08-13-0263-design-task-book.md §9-2.1 (the probe runs on a
//     server-side timer, the page only reads the latest result + its timestamp; a public-page
//     visitor directly triggering a liveness probe = handing the probe to arbitrary
//     traffic to amplify — not done), §9-2.2 (🔴 the green-dot anti-cache rule), §9-2.3 (v1 only does current state,
//     no history bar — no new table), §9-2.6 (W-5a acceptance)
//   apps/server-core/src/status/managed-stt-health.ts (the STT half)
//   apps/server-core/src/compose/llm-health.ts (`probeManagedLlmLiveness` — the
//     LLM half. 🔴 FB-11 CLOSED HERE: see the note on `probeLlm` below)
//   apps/server-core/src/stt/pool-health.ts (the "a probe that threw says nothing
//     ⇒ record NOTHING" rule this copies)
//
// The status probe timer: run both managed-line probes on an interval, keep the
// last result WITH its timestamp in memory, and answer questions about it.
//
// ── 🔴 THE ANTI-CACHE RULE IS THE POINT OF THIS FILE (§9-2.2) ───────────────
// A status page whose green dot is a stored value has one failure mode that
// matters more than every other: the prober dies and the page keeps showing the
// last thing it knew, forever, confidently. So a stored result EXPIRES. Past
// {@link STATUS_STALE_FACTOR} × the interval, every target reads `'unknown'` —
// which is a THIRD word, not a synonym for `'down'`. Saying "unknown" as "broken" is
// the same lie pointed the other way (book 15 §1.4), and the two have opposite
// consequences for a reader deciding whether to file a report.
//
// 🔴 STALENESS APPLIES TO EVERY STORED VALUE, INCLUDING `not_configured` AND
// INCLUDING A STORED `down`. Two carve-outs suggest themselves and both are
// refused:
//   · "a stale `down` can stay `down`, the rule only says never stay green" —
//     no: a fixed outage reported as still-broken is exactly the direction of
//     dishonesty the sentence above names, and it is the one that makes a status
//     page useless during recovery;
//   · "`not_configured` comes from env, which cannot change at runtime, so it
//     need not expire" — no: the value being derivable is not the question. The
//     endpoint answers from a SNAPSHOT by design (§9-2.1), and a dead prober
//     must not be able to speak confidently about anything. A carve-out would
//     leave one target answering crisply while the mechanism behind it is dead,
//     which is the single observation that would have told a reader it was dead.
// ⇒ ONE rule, no exceptions to get wrong: a dead timer turns BOTH managed rows
// to `'unknown'` together, and that is the signal.
//
// ⚠️ NO HISTORY, NO TABLE, NO SCHEMA (§9-2.3). State is one Map in this closure.
// v1 answers "right now" and nothing else; a history bar needs a table, a retention
// policy, and a semantics for "what counts as a gap", and the design weighs v1's value
// density as not worth that. An in-memory store also means a relay restart reads
// as `'unknown'` until the first tick — correct, and not something to paper over.

import { probeManagedLlmLiveness } from '../compose/llm-health';
import { log } from '../log';
import { probeManagedSttLiveness } from './managed-stt-health';

/** How often the timer fires. 60 s: fast enough that a real outage surfaces
 *  within a page refresh or two, slow enough that two provider sessions per
 *  minute is nothing. Named because {@link STATUS_STALE_FACTOR} multiplies it —
 *  the two numbers must move together or the anti-cache rule drifts. */
export const STATUS_PROBE_INTERVAL_MS = 60_000;

/** A result older than this many intervals is not an answer any more (§9-2.2).
 *  2 rather than 1: one missed tick is a slow provider, not a dead prober, and
 *  flapping to `'unknown'` on every slow round trip would train readers to
 *  ignore the word. */
export const STATUS_STALE_FACTOR = 2;

/** The two lines this timer measures. The relay's own row is NOT here: it is not
 *  probed, it is self-evident (see http/status-routes.ts). */
export type ProbeTarget = 'managed_stt' | 'managed_llm';

/** What a probe can conclude. `'unknown'` is never STORED — it is what the
 *  snapshot returns for something stale or never measured. */
export type MeasuredStatus = 'up' | 'down' | 'not_configured';
export type TargetStatus = MeasuredStatus | 'unknown';

export interface StatusTargetView {
  readonly status: TargetStatus;
  /** When the underlying measurement was taken, or `null` when there is none
   *  (never probed, or expired). 🔴 A `'unknown'` row MUST carry `null` here and
   *  not the timestamp of the value it just refused to report — publishing a
   *  fresh-looking timestamp beside "unknown" is the cached green wearing a hat. */
  readonly checked_at: number | null;
}

export interface ProbedTargets {
  readonly managed_stt: StatusTargetView;
  readonly managed_llm: StatusTargetView;
}

export interface StatusProbeRunner {
  /** Arm the interval. Idempotent. */
  start(): void;
  /** Disarm. Idempotent. Called by the shutdown sequence — and by the reverse
   *  control, which is the same act: this is how "kill the probe" is expressed in a test. */
  stop(): void;
  /** One round, awaited. The production timer calls this; tests call it directly
   *  so nothing here needs fake timers. Never rejects. */
  runOnce(): Promise<void>;
  /** Current view, with the staleness rule applied against `now`. */
  snapshot(now?: number): ProbedTargets;
}

export interface StatusProbeDeps {
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  now?: () => number;
  /** Test seams. Production passes nothing and gets the real probes.
   *  🔴 FB-11 — `probeManagedLlmLiveness` had ZERO production consumers: its own
   *  header says so, calls itself "a MEASUREMENT primitive" whose only caller is
   *  a drill, and names the missing consumer as a deferred ops-console item. THIS
   *  TIMER IS THAT CONSUMER. The façade is closed by being called on a schedule
   *  in production, not by being re-described. If this wiring is ever removed,
   *  that file goes back to being a capability nobody invokes — which is this
   *  repo's #1 historical bug shape, and the reason its header is written the way
   *  it is. */
  probeStt?: (env: NodeJS.ProcessEnv) => Promise<{ ok: boolean } | null>;
  probeLlm?: (env: NodeJS.ProcessEnv) => Promise<{ ok: boolean } | null>;
}

interface StoredResult {
  readonly status: MeasuredStatus;
  readonly checked_at: number;
}

const NEVER_MEASURED: StatusTargetView = { status: 'unknown', checked_at: null };

/** verdict → stored status. `null` from either probe means "this line isn't configured", which
 *  both probe modules return by the same convention. */
function statusOf(verdict: { ok: boolean } | null): MeasuredStatus {
  if (verdict === null) return 'not_configured';
  return verdict.ok ? 'up' : 'down';
}

export function makeStatusProbes(deps: StatusProbeDeps = {}): StatusProbeRunner {
  const env = deps.env ?? process.env;
  const intervalMs = deps.intervalMs ?? STATUS_PROBE_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const probeStt = deps.probeStt ?? ((e): Promise<{ ok: boolean } | null> => probeManagedSttLiveness(e));
  const probeLlm = deps.probeLlm ?? ((e): Promise<{ ok: boolean } | null> => probeManagedLlmLiveness(e));

  const results = new Map<ProbeTarget, StoredResult>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function runTarget(
    target: ProbeTarget,
    probe: (e: NodeJS.ProcessEnv) => Promise<{ ok: boolean } | null>,
  ): Promise<void> {
    try {
      const verdict = await probe(env);
      const status = statusOf(verdict);
      const prev = results.get(target);
      results.set(target, { status, checked_at: now() });
      // Log it, both directions — a line coming back is as much news as one going
      // down (pool-health.ts's registry makes the same argument). Only on CHANGE:
      // a healthy line would otherwise write a log line every minute forever.
      if (prev?.status !== status) {
        log.info('status.probe target changed', { target, from: prev?.status ?? 'unknown', to: status });
      }
    } catch (err) {
      // 🔴 RECORD NOTHING. A probe that itself threw says nothing about the
      // target (pool-health.ts, verbatim reasoning): inventing a `down` here
      // would publish an outage for a bug in our own probe. The previous result
      // stands and then EXPIRES on its own, so a probe that keeps throwing ends
      // at `'unknown'` — which is precisely what we know.
      log.warn('status.probe threw', { target, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function runOnce(): Promise<void> {
    // One round at a time. A probe can outlive the interval (the STT settle
    // window alone is ~900 ms, and `open()` has an 8 s ceiling), and overlapping
    // rounds would open provider sessions faster than they close.
    if (inFlight) return;
    inFlight = true;
    try {
      await Promise.all([
        runTarget('managed_stt', probeStt),
        runTarget('managed_llm', probeLlm),
      ]);
    } finally {
      inFlight = false;
    }
  }

  function viewOf(target: ProbeTarget, at: number): StatusTargetView {
    const stored = results.get(target);
    if (stored === undefined) return NEVER_MEASURED;
    if (at - stored.checked_at > STATUS_STALE_FACTOR * intervalMs) return NEVER_MEASURED;
    return { status: stored.status, checked_at: stored.checked_at };
  }

  return {
    start(): void {
      if (timer !== null) return;
      // Kick one immediately so a fresh relay is not `'unknown'` for a whole
      // interval, then settle into the cadence.
      void runOnce();
      timer = setInterval(() => { void runOnce(); }, intervalMs);
      // 🔴 unref: a 60 s interval that holds the event loop open would keep the
      // process — and every test that boots a server — alive past its work. The
      // shutdown sequence still calls stop() explicitly; this is the belt to that
      // braces, not a replacement for it.
      timer.unref?.();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
    snapshot(at = now()): ProbedTargets {
      return {
        managed_stt: viewOf('managed_stt', at),
        managed_llm: viewOf('managed_llm', at),
      };
    },
  };
}
