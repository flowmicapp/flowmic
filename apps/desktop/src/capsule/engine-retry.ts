// NR-96-C (2026-09-24) — the capsule engine cell while the relay reconnects.
// Contract: book 15 §2.7 (the five laws) and §4 R3's executable form; wire:
// protocol `SttEngineStatusSchema` (`retry_count`, and the NR-96 fields
// `retry_max` / `retry_in_ms` / `attempt_timeout_ms`, only on `reconnecting`
// frames — pinned on the producer by
// apps/server-core/test/engine-reconnect-progress.test.ts).
//
// One value, one question (law 5): `n` answers "how many attempts", never "is
// the engine alive". MAIN's ruling on the follow-up (2026-09-24): a
// "Reconnecting…" that nothing backs any more is a false statement, so the
// face lives exactly as long as a fact backs it —
//   · a newer status frame replaces it (ready / failed / loading / reconnecting);
//   · an interim moves the cell to ready: interims are emitted only from a live
//     engine's own handler (orchestrator-core.ts `handlers.interim`). Finals are
//     deliberately NOT used as that proof: the relay also emits a final folded
//     from its accumulators after the engine is gone (the RT3-B terminal final,
//     book 15 §3.2 engine-ladder row), and after a release mid-reconnect that
//     final would paint a dead engine "ready";
//   · the local watchdog, the utterance's start and its stop BLANK the cell:
//     the truth is unknown, so it says nothing — not "ready", not "failed", not
//     "Not checked" (NR-38: that would be false about an engine that is there).
//
// The watchdog deadline comes from facts on the frame (receipt time +
// `retry_in_ms` + `attempt_timeout_ms`). A frame without both (an old relay)
// gets the ladder's worst case instead, `ENGINE_RECONNECT_WORST_CASE_MS` —
// derived in @flowmic/protocol from the same AUDIO_DEFAULTS the relay's ladder
// reads, never a number typed here (R3: no unsourced constants).

import { ENGINE_RECONNECT_WORST_CASE_MS } from '@flowmic/protocol';
import { S } from '../lib/strings';

export interface EngineRetry {
  /** Attempt number from `retry_count` (≥ 1), or null when the frame has none. */
  n: number | null;
  /** Total budget from `retry_max`, or null — absent means unbounded, and an
   *  invented total would be a lie (book 15 §2.7 wording model). */
  max: number | null;
  /** Local-clock ms after which the relay has fallen silent on this reconnect. */
  expiresAt: number;
}

function posInt(v: unknown, min: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null;
}

function field(p: unknown, k: string): unknown {
  return p !== null && typeof p === 'object' ? (p as Record<string, unknown>)[k] : undefined;
}

/** What a `reconnecting` frame licenses the cell to say, and until when. */
export function engineRetryFromFrame(p: unknown, now: number): EngineRetry {
  const n = posInt(field(p, 'retry_count'), 1);
  const maxRaw = posInt(field(p, 'retry_max'), 1);
  const wait = posInt(field(p, 'retry_in_ms'), 0);
  const cap = posInt(field(p, 'attempt_timeout_ms'), 1);
  return {
    n,
    // "attempt 3 of 2" is a contradiction, not a fact — say n alone instead.
    max: n !== null && maxRaw !== null && maxRaw >= n ? maxRaw : null,
    expiresAt: now + (wait !== null && cap !== null ? wait + cap : ENGINE_RECONNECT_WORST_CASE_MS),
  };
}

/** True once the frame's own deadline has passed without a newer frame. */
export function engineRetryExpired(r: EngineRetry, now: number): boolean {
  return now >= r.expiresAt;
}

/** The `reconnecting` cell's text: counted when a count is held, the plain
 *  pre-NR-96 face otherwise. */
export function reconnectingLabel(r: EngineRetry | null): string {
  if (r === null || r.n === null) return S.cap_stt_reconnecting;
  if (r.max === null) return S.cap_stt_reconnecting_n.replace('{n}', String(r.n));
  return S.cap_stt_reconnecting_n_of.replace('{n}', String(r.n)).replace('{max}', String(r.max));
}
