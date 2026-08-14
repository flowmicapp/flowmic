// 🔴 W8-4 (card fix-020) — WHICH ceiling ended the recording → WHAT the user is
// told. Owns the `HardLimitOrigin` → `audio:auto-stopped{reason}` table, the
// derived reason type, and the narrowing that refuses to name an origin it does
// not know. Nothing here touches the session, the engine or the socket: it is a
// pure lookup, which is why it can be read (and pinned) on its own.
//
// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs), not by an architectural claim — the bridge was
// already at 792 lines when this family was written. The code moved VERBATIM,
// comments with it; read the seam as "this family happened to move as one
// block", not as "auto-stop policy is now a layer". The one caller is
// `stt-session.ts` `onAutoStopped`.

import type { EventPayload } from '@flowmic/protocol';
import type { HardLimitOrigin } from '../stt/audio/session';

/** The wire `reason` of `audio:auto-stopped`, read OFF the protocol schema
 *  (`AudioAutoStoppedSchema`, packages/protocol/src/protocol-schemas-audio.ts)
 *  instead of re-typed here. Re-typing it would create a second answer to
 *  "which values are legal" that drifts silently; derived, a value added or
 *  removed there changes this type and the table below with it. */
export type AutoStopReason = EventPayload<'audio:auto-stopped'>['reason'];

/**
 * 🔴 W8-4 — WHICH ceiling ended the recording → WHAT the user is told.
 *
 * This table IS the card. Before it, [[SttSessionBridge.onAutoStopped]] threw
 * `limit_origin` away and emitted a constant `reason:'hard_limit'`, so the phone
 * said "recording has reached the 5-minute cap" in four languages no matter why
 * the recording ended.
 * Card N1-B4 (`stt/audio/session.ts` `onHardLimit`) turned the five-minute wall
 * into an engine-session ROLLOVER the user never sees, which leaves quota
 * exhaustion as the only origin that still ends a recording — i.e. the constant
 * was on its way to being wrong every single time it fired.
 *
 * 🔴 `satisfies Record<HardLimitOrigin, …>` IS THE GATE, and it is the reason
 * this is a table rather than a `switch` with a `default`. A third origin added
 * to `HardLimitOrigin` does not silently inherit a neighbour's sentence — it
 * FAILS TO COMPILE until somebody decides what that origin honestly says. The
 * defect being closed here is precisely "an origin with no honest reason gets
 * lent an existing one", so the fix must make the lending impossible rather than
 * merely not do it today. There is deliberately no `default:` anywhere in this
 * file's auto-stop path.
 *
 * ⚠️ ORIGIN ≠ REASON, and the two vocabularies are kept apart on purpose (the
 * schema's own note says the same in the same words): `HardLimitOrigin` answers
 * "where did this ceiling come from", `reason` answers "why did the recording
 * stop". `quota_budget` and
 * `quota_exhausted` are therefore NOT the same word by accident of taste — one
 * value answering both questions is this repo's #1 bug shape.
 */
const AUTO_STOP_REASON_BY_ORIGIN = {
  // An engineering ceiling. Correct, unchanged, and still the honest sentence
  // for a real time wall — this value is not deprecated by the row below it.
  engine_session: 'hard_limit',
  // The user is out of minutes. "press again to keep talking" is false here and
  // "quota exhausted" is
  // false for the row above; no single wording covers both, which is why the
  // enum grew a value (owner 2026-08-10, ruling group #5-a) instead of one
  // sentence being softened to fit two situations.
  quota_budget: 'quota_exhausted',
} as const satisfies Record<HardLimitOrigin, AutoStopReason>;

/** The origins this layer can name, for the fail-loud log below. Exported
 *  INSTEAD of the table so no caller can index it directly and skip the
 *  `Object.hasOwn` guard that [[autoStopReasonFor]] exists to apply. */
export const NAMEABLE_AUTO_STOP_ORIGINS: readonly string[] = Object.keys(AUTO_STOP_REASON_BY_ORIGIN);

/**
 * The origin as it arrived on the wire-adjacent event payload → its reason, or
 * `null` when this layer cannot name one.
 *
 * `null` is NOT a fallback value in disguise: the caller refuses to emit rather
 * than picking a sentence, because every branch that "picks something" here is a
 * re-creation of the defect above.
 *
 * ⚠️ `Object.hasOwn` is load-bearing and not a formality. A plain object literal
 * inherits from `Object.prototype`, so a bare `table['toString']` returns a
 * FUNCTION rather than `undefined` — a truthy non-reason that would sail into
 * the emit. Pinned by a test rather than trusted to review.
 */
export function autoStopReasonFor(origin: unknown): AutoStopReason | null {
  if (typeof origin !== 'string') return null;
  if (!Object.hasOwn(AUTO_STOP_REASON_BY_ORIGIN, origin)) return null;
  // Widened to an index signature rather than narrowed with a hand-written
  // `origin is HardLimitOrigin` predicate: volume-13 ⑤ — a hand-written type
  // predicate is an assertion the compiler does not check, and this file has no
  // need of one. The `hasOwn` above is the real check; this line only reads.
  const table: Record<string, AutoStopReason | undefined> = AUTO_STOP_REASON_BY_ORIGIN;
  return table[origin] ?? null;
}
