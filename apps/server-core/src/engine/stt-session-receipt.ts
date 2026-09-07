// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b) — the coverage receipt (SSOT)
//   packages/protocol/src/recovery-protocol.ts — the wire schema it fills
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft §A7-1
//
// Card CV-1's server half: the facts that go on the TERMINAL `stt:final` so the
// phone can decide whether its local copy of the audio is still the only copy.
//
// ⚠️ IT LIVES IN ITS OWN FILE BECAUSE `stt-session.ts` WAS AT 793 OF THE
// 800-LINE CAP (verify/lint/file-size.mjs), the same split `stt-session-deps.ts`
// / `stt-session-refine.ts` / `stt-session-detached-polish.ts` already record.
// The bridge therefore holds ONE field of this type and spreads one call; every
// sentence explaining the fields is here, where the subject is.
//
// ── WHAT THIS RECEIPT IS ALLOWED TO DECIDE ──────────────────────────────────
// 🔴 NOTHING ON ITS OWN. `fed_frames` matching the phone's send count does not
// prove the CONTENT matched (a replay produces the same count, so does
// zero-fill), and `seq_gaps === 0` says nothing whatsoever about whether the
// words are right — audit §A5-4 states outright that no machine criterion for
// the latter exists. The 2026-09-06 ruling lets these numbers gate exactly one
// action, deletion of the phone's local audio, and only in company:
//   ① L2 completeness — fed_frames equals what the phone sent, seq_gaps 0,
//      drops 0, AND the receipt version is one the phone recognises;
//   ② `ended_normally === true`;
//   ③ a persisted, read-back result row + an fsync'd manifest resultRef.
// Two of the three is not the threshold. That judgement is the PHONE's (card
// RC-1); this module only supplies the facts honestly, including the ones that
// say "do not delete anything".

import type { CoverageReceiptFields } from '@flowmic/protocol';
import { COVERAGE_RECEIPT_VERSION } from '@flowmic/protocol';
import type { AudioSession } from '../stt/audio/session';

/**
 * The subset of `audio:start`'s recovery identifiers that comes back on the
 * terminal final.
 *
 * 🔴 ECHOED, NEVER DERIVED. The server does not parse `job_id`'s structure, does
 * not validate the range against the bytes it received, and does not invent a
 * `recording_id` for a phone that sent none. A "helpful" default here would be
 * the server answering a question only the phone can answer, and the phone would
 * have no way to tell the two apart — which is this repo's #1 defect shape with
 * the roles reversed.
 *
 * ⚠️ `operation_id` and `job_id` are deliberately NOT echoed: nothing on the
 * phone keys a receipt by either today, and a field with no reader is the thing
 * this repo keeps having to delete. They travel on `audio:start` because card
 * PR-2 (persistent idempotency) is the layer that will read `operation_id`.
 */
export interface RecoveryEcho {
  recording_id?: string;
  attempt_id?: string;
  range_start_sample?: number;
  range_end_sample?: number;
}

/**
 * Lift the echoable identifiers off a parsed `audio:start`. Returns `undefined`
 * when the frame carried none, so "an old phone that stamps nothing" and "a
 * phone that stamped an empty recording id" cannot become the same thing.
 */
export function recoveryEchoOf(start: {
  recording_id?: string;
  attempt_id?: string;
  range_start_sample?: number;
  range_end_sample?: number;
}): RecoveryEcho | undefined {
  const echo: RecoveryEcho = {
    ...(start.recording_id !== undefined ? { recording_id: start.recording_id } : {}),
    ...(start.attempt_id !== undefined ? { attempt_id: start.attempt_id } : {}),
    ...(start.range_start_sample !== undefined ? { range_start_sample: start.range_start_sample } : {}),
    ...(start.range_end_sample !== undefined ? { range_end_sample: start.range_end_sample } : {}),
  };
  return Object.keys(echo).length === 0 ? undefined : echo;
}

/** Everything the tally needs that it does not own itself. */
export interface CoverageReceiptInput {
  /** The run's own counters: gaps and engine-leg rollovers.
   *
   *  🔴 `droppedChunks` IS DELIBERATELY NOT READ HERE, and its absence from this
   *  `Pick` is the mechanism rather than tidiness — adding it back does not
   *  compile past this line without someone saying why. See {@link droppedFrames}. */
  session: Pick<AudioSession, 'gapEvents' | 'legRollovers'>;
  /** `audio:chunk` frames the PIPELINE took — decoded by the bridge AND accepted
   *  by the session. Audit F3: this used to mean 「decoded」 alone, which counted
   *  a frame that arrived past the terminal fence as fed. */
  acceptedFrames: number;
  /**
   * Every frame that was received and delivered nowhere — `FrameTally.dropped`,
   * whole (engine/stt-session-intake.ts). That tally already covers both places
   * a frame can be turned away: the bridge's own refusals (disposed,
   * undecodable, empty), and a frame the orchestrator judged `'refused'`.
   *
   * 🔴 THIS IS THE ONLY DROP SOURCE THE RECEIPT READS, and it used to be added to
   * `AudioSession.droppedChunks` under a comment claiming the two were 「disjoint
   * by construction」. They are not, and never were: `orchestrator-core.pushChunk`
   * DERIVES its `'refused'` verdict from a delta on that very counter, so a frame
   * the session turned away increments `droppedChunks` and then lands in
   * `FrameTally.dropped` as well. Summing them counted one frame twice, and the
   * receipt exists so the phone can decide whether its only copy of the audio is
   * still needed — a `drops` that overstates is the safe direction to be wrong in,
   * but 「fed + drops equals what I sent」 is the identity the phone actually checks,
   * and a double count breaks it just as thoroughly as a missing count.
   *
   * ⚠️ ONE SOURCE, so the identity holds by construction: `FrameTally` puts every
   * frame in exactly one bucket, and every production `session.pushChunk` runs
   * inside `orchestrator.pushChunk`, whose verdict `stt-session.ts` always notes.
   */
  droppedFrames: number;
  /** True from the moment `finish()` is entered. */
  finishing: boolean;
  /** True once `dispose()` has run — the watchdog-forced teardown included. */
  disposed: boolean;
  /** What the start frame carried, or undefined. */
  echo?: RecoveryEcho | undefined;
}

/**
 * The per-session tally. One instance per {@link import('./stt-session')
 * SttSessionBridge}; it owns exactly one piece of state — "did this run get
 * auto-stopped" — and reads the rest at the moment the receipt is built.
 */
export class CoverageReceiptTally {
  private autoStopped = false;

  /**
   * Called at the TOP of the bridge's auto-stop handler, before it awaits the
   * terminal flush.
   *
   * 🔴 THE ORDER IS THE MECHANISM, not tidiness: the terminal final arrives out
   * of `waitForTerminal()` a few lines later, so a flag set afterwards would
   * describe the next recording rather than this one. Setting it first is what
   * makes `ended_normally:false` true of the frame that carries it.
   */
  noteAutoStop(): void {
    this.autoStopped = true;
  }

  /**
   * Build the fields for THIS terminal final. Callers must only spread it onto a
   * final with `is_segment:false` — a soft-segment boundary is not a conclusion
   * about a recording, and a receipt on one would name a range nobody asked
   * about.
   *
   * 🔴 `ended_normally` IS THREE FACTS AND-ED TOGETHER, and each one is a real
   * way this chain ends without a clean flush:
   *   · `finishing` false  — a terminal final that did not come out of
   *     `finish()` at all (the engine ended the session on its own);
   *   · `autoStopped` true — a ceiling or a quota ended the recording;
   *   · `disposed` true    — the audio handler's finish watchdog gave up on a
   *     stuck `finish()` and tore the session down anyway
   *     (`AUDIO_STOP_FINISH_WATCHDOG_MS`). A final that arrives after that has a
   *     torn-down session behind it, so whatever else is true, the flush did not
   *     complete normally.
   * ⚠️ It is NOT a claim that the vendor is finished with the range — that is L3
   * and does not exist anywhere in this chain today (card CV-2). It is the
   * closest OBSERVABLE fact, which is what the ruling asked for and all it asked
   * for.
   *
   * ⚠️ `drops` is {@link CoverageReceiptInput.droppedFrames} verbatim — ONE
   * source, no arithmetic. It does not include replay de-duplication: the
   * orchestrator drops an already-observed seq on purpose, and counting the
   * ring-replay mechanism working as audio lost would make every reconnect look
   * like damage.
   */
  fields(input: CoverageReceiptInput): CoverageReceiptFields {
    return {
      coverage_receipt_version: COVERAGE_RECEIPT_VERSION,
      fed_frames: input.acceptedFrames,
      seq_gaps: input.session.gapEvents,
      drops: input.droppedFrames,
      engine_leg_rollovers: input.session.legRollovers,
      ended_normally: input.finishing && !this.autoStopped && !input.disposed,
      ...(input.echo ?? {}),
    };
  }
}
