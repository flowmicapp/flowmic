// NR-138 item 5 — WHEN A TRANSCRIPTION SESSION IS NOT CHARGED.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.10 (the rule, the failure set, the non-failures)
//   docs/decisions/2026-10-01-owner-engine-failure-no-charge.md (owner ruling: 「还给用户」, option ②)
//
// ── THE RULE IN ONE LINE ────────────────────────────────────────────────────
//
// A session that ends on an ENGINE-FAILURE FACT and emitted NO USABLE TRANSCRIPT settles uncharged. A partial
// usable transcript bills normally. Nothing here looks at whether text is empty to decide that the engine FAILED:
// silence, an empty but normal recognition and a cancel produce no failure fact and stay billed exactly as before
// (the ruling's own warning: 「没出字」 is not 「我们失败」).
//
// ── WHY A LATCH OBJECT AND NOT FOUR FIELDS ON THE BRIDGE ────────────────────
//
// The verdict needs facts that arrive at four different moments (an engine error, a later recovery, a final that
// carried words, a watchdog in another file), and it is read once, at settle. One small object that each moment
// writes to and settle reads from keeps that ordering in one place — and keeps `engine/stt-session.ts`, which sits
// near the 800-line cap, to a handful of call lines.

import type { ErrorCode } from '@flowmic/protocol';
import type { SttEngineFailure } from './stt-session-deps';
import { log } from '../log';
import { relayIsShuttingDown } from './relay-lifecycle';

/** The protocol's STT codes. A code added to the registry later fails to compile below until it is classified. */
type SttCode = Extract<ErrorCode, `STT_${string}`>;

/**
 * 🔴 EXHAUSTIVE BY TYPE: every `STT_*` code in the protocol registry, and whether the orchestrator SPEAKING it
 * means our engine failed. Book 22 §4.10 lists the same set; this table is the code anchor it names.
 *
 *   true  — the engine timed out, stalled, refused, could not be reached or lost its connection;
 *   false — not a session-engine fact at all (the two probe codes belong to the settings test route,
 *           `http/probe-routes.ts`, which bills nothing).
 */
const STT_CODE_IS_ENGINE_FAILURE: Record<SttCode, boolean> = {
  STT_ENGINE_TIMEOUT: true, // flush refused or timed out, incl. an empty flush that timed out after audio was fed
  STT_NETWORK_DROP: true, // engine connection lost / ladder exhausted; also the bridge's default for an uncoded error
  STT_NO_ENGINE_REACHED: true, // voice captured and no engine was ever fed
  STT_ENGINE_NOT_OPEN: true,
  STT_ENGINE_AUTH_FAIL: true,
  STT_ENGINE_RATE_LIMITED: true,
  STT_CONFIG_MISSING: true,
  STT_POOL_NO_ROUTE: true,
  STT_LANGUAGE_UNSUPPORTED: true,
  STT_SEGMENT_NOT_TRANSCRIBED: true, // captured words the closing path could not deliver
  STT_PROBE_FAIL: false,
  STT_PROBE_SCHEME_MISMATCH: false,
};

/** The codes book 22 §4.10 calls engine failures — the grep anchor `ENGINE_FAILURE_CODES`. */
export const ENGINE_FAILURE_CODES: ReadonlySet<string> = new Set(
  (Object.keys(STT_CODE_IS_ENGINE_FAILURE) as SttCode[]).filter((c) => STT_CODE_IS_ENGINE_FAILURE[c]),
);

export function isEngineFailureCode(code: string): boolean {
  return ENGINE_FAILURE_CODES.has(code);
}

/**
 * One session's no-charge verdict, written at the moments its facts happen and read once at settle.
 *
 * Wired in `engine/stt-session.ts` (`o.on('error')`, `o.on('engine-status')`, `emitFinal`, `noteFinishFailure`,
 * and `dispose()` → `noteTeardown`) and read by its `settle()`.
 */
export class EngineFailureLatch {
  private fact: SttEngineFailure | null = null;
  private usableTextDelivered = false;

  /** The orchestrator SPOKE an error (a frame it suppressed as our own silence never reaches here). */
  noteError(code: string): void {
    if (isEngineFailureCode(code)) this.fact = { kind: 'engine_error', code };
  }

  /** `engine-status: ready` — the engine came back, so an EARLIER engine error no longer decides the session:
   *  what happens next does (a later error, a final with words, or a normal end). A finish failure is never
   *  cleared: it is the end of the session, nothing reports after it. */
  noteRecovered(): void {
    if (this.fact?.kind === 'engine_error') this.fact = null;
  }

  /** The relay gave up on `finish()` — its watchdog fired, or `finish()` rejected (socket/handlers/audio.handler.ts). */
  noteFinishFailure(kind: 'finish_watchdog' | 'finish_failed'): void {
    this.fact = { kind };
  }

  /** The bridge is tearing down a session that has not settled (`SttSessionBridge.dispose()`). MAIN extension
   *  2026-10-01 (book 22 §4.10 item 4): if the relay is shutting down (`relay-lifecycle.ts`), the relay cut it off.
   *  Like a finish failure it is the end of the session, so it replaces any earlier fact. Otherwise (a phone that
   *  dropped, a supersede, a grace expiry while the relay runs) the teardown is no fact at all. */
  noteTeardown(): void {
    if (relayIsShuttingDown()) this.fact = { kind: 'relay_shutdown' };
  }

  /** A `stt:final` left the bridge carrying [text]. Whitespace is not a usable transcript. */
  noteDelivered(text: string): void {
    if (text.trim() !== '') this.usableTextDelivered = true;
  }

  /** The fact this session settles UNCHARGED with, or null when it is charged on the §4.9 bases as before. */
  verdict(): SttEngineFailure | null {
    return this.usableTextDelivered ? null : this.fact;
  }
}

/** The one line a not-charged session leaves (book 22 §4.10: no increment, no claim, no `usage_events` row). Both
 *  trackers call it — the writer's (`billing/usage-tracker.ts`) and a replica's forwarding one
 *  (`node/forwarding-usage-tracker.ts`), which forwards nothing for such a session. */
export function logNotCharged(user_id: string, duration_ms: number, failure: SttEngineFailure, where: string): void {
  log.info('usage: not charged — engine failure', {
    user_id,
    attempted_ms: Math.round(duration_ms),
    failure: failure.kind,
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    where,
  });
}
