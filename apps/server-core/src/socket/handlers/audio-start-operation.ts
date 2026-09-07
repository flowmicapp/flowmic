// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6-1 (the four identity layers), §A7-2 (the two keys), §A9 stage 3, card PR-2
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (a) — the recovery identifiers
//   apps/server-core/src/db/repos/recovery-operations.repo.ts (the table)
//
// Card PR-2's `audio:start` admission step: register this recovery operation, or
// recognise a re-send of it, or refuse a re-send that says something different.
//
// 2026-09-06 (lane EC): the refusal now carries its own registered code,
// `AUDIO_OP_BINDING_CONFLICT`. See that constant for what the borrowed one was
// telling users to do.
//
// ⚠️ IT LIVES IN ITS OWN FILE BECAUSE audio.handler.ts IS THE FILE THE AUDIT
// SINGLES OUT (§A9: 「先拆再加」). The handler gets one call and one branch; every
// sentence explaining the decision is here, where the subject is.
//
// 🔴 THIS STEP DOES NOT BILL AND DOES NOT DEDUPE BILLING. It answers 「have I seen
// this REQUEST」; 「has this operation already moved a counter」 is a different key
// and a different table (db/repos/usage-effects.repo.ts), for the reason §A7-2
// gives: one operation legitimately meters twice.
//
// 🔴 AND IT DOES NOT RETURN A CACHED RESULT. Ruling O-9 (乙) is explicit — the
// server keeps no transcript, so a re-send is RE-RECOGNISED. What the user is
// spared is the second charge, not the second recognition; the vendor cost is
// ours. Anyone reading this file for 「where do we return the original result」
// should stop here: that is option 甲 and it was set aside.

import type { RecoveryOperationsRepo } from '../../db/repos/recovery-operations.repo';
import type { ErrorPayload } from '../../errors';

/** The subset of a parsed `audio:start` this step reads. Structural rather than
 *  the schema type, so the module can be driven directly by a test without
 *  building a whole frame. */
export interface OperationStartFacts {
  operation_id?: string | undefined;
  recording_id?: string | undefined;
  range_start_sample?: number | undefined;
  range_end_sample?: number | undefined;
  attempt_kind?: string | undefined;
  mode: string;
}

/**
 * The registered code for 「you re-used an operation id for a different piece of
 * audio」 — owner approved it on 2026-09-06, and the borrowing this file carried
 * until then is gone
 * (docs/decisions/2026-09-06-owner-grants-error-code-audio-op-binding-conflict.md).
 *
 * 🔴 WHY THE BORROWED CODE HAD TO GO, kept here because the argument is the
 * reason this code exists and not a piece of history. The stand-in was
 * `STT_NO_ENGINE_REACHED`, whose registered sentence ends 「say it again; if it
 * keeps happening, check the engine settings」 — the first half names the action
 * that PRODUCES this refusal (a re-press re-sends the same operation), the
 * second sends the user to engines that are working. It also left
 * `stt/empty-final-verdicts.ts` branching on a code with two authors, which is
 * this repo's #1 defect shape.
 *
 * The new sentence asks for nothing, because there is nothing to ask for: the
 * phone mints a fresh operation for its next attempt on its own
 * (apps/mobile/lib/src/session/recovery_journal_leg.dart, `_attempt`), and the
 * half the user would otherwise have to guess at — 「the earlier result and
 * charge are unchanged」 — is true by construction (A7-2: billing is a different
 * key and a different table, and a refused start never reaches it).
 */
export const OPERATION_CONFLICT_CODE = 'AUDIO_OP_BINDING_CONFLICT';

/**
 * 🔴 A SECOND, DIFFERENT REFUSAL — and it deliberately does NOT use the code
 * above. This arm answers 「this deployment cannot protect recovery operations
 * at all」, not 「your re-send described different audio」; putting the granted
 * code here would re-create, one arm over, exactly the one-value-two-questions
 * defect the grant was made to remove.
 *
 * ⚠️ STATED AS AN OPEN ACCOUNT, NOT SOLVED HERE. No registered code says
 * 「this server advertises operation idempotency and has no registry wired」, and
 * owner granted one code, for the conflict. `STT_NO_ENGINE_REACHED` is still
 * the least-lying registered option for this arm — the recording did reach no
 * engine and nothing was transcribed — and its trailing 「check the engine
 * settings」 remains wrong. It is left in place rather than swapped for another
 * borrowed code because a second grant is an owner gate and this arm is
 * UNREACHABLE on a correctly wired server: `deps.recoveryOps` comes from
 * db/connection.ts (`makeRecoveryOperationsRepo`), which is not optional there.
 * ⇒ If a real deployment is ever seen taking this branch, that is the evidence
 * to ask owner with, and it is the only thing that should re-open it.
 *
 * 🔴 IT DOES NOT REACH `vendorNoAudioIsOurSilence`. That predicate
 * (stt/empty-final-verdicts.ts) branches on this same code string, and an
 * admission refusal must never be mistaken for a vendor's 「no audio received」.
 * It cannot be: this refusal leaves through `refuseStart` on the `audio:start`
 * ack path, while that predicate is consulted only on a LIVE leg's engine-error
 * exit (`SttEngineOrchestrator.emitEngineError`). Two paths that never meet —
 * asserted, not assumed, in test/operation-idempotency.test.ts.
 */
export const OPERATION_REGISTRY_UNWIRED_CODE = 'STT_NO_ENGINE_REACHED';

export type OperationAdmissionResult =
  /** Admitted. `operation_id` is undefined for a frame that named none — every
   *  ordinary press, and every phone that predates card PR-1. */
  | { ok: true; operation_id?: string | undefined; registered?: 'registered' | 'resend' }
  /** Refused. The caller must go through `refuseStart` so the refusal reaches the
   *  phone and the journal, not through a bare ack (QTA-1). */
  | { ok: false; error: ErrorPayload };

/**
 * Decide whether this `audio:start` may proceed, and register it if so.
 *
 * 🔴 FAIL CLOSED WHEN THE FRAME CARRIES AN OPERATION AND NO REGISTRY IS WIRED.
 * The server ADVERTISES `recovery.idempotent_operation`, and audit §A7-3 names
 * 「a bit we do not honour」 as the worst outcome available: the phone reads a
 * present bit as permission to stop protecting its own audio. Proceeding
 * unprotected would make the advertisement a lie for that deployment; refusing
 * makes a mis-wiring loud on its first recovery attempt. A frame with NO
 * operation is unaffected either way, which is every session that exists today.
 */
export function admitOperation(
  repo: RecoveryOperationsRepo | undefined,
  userId: string,
  start: OperationStartFacts,
  at: number,
): OperationAdmissionResult {
  const operation_id = start.operation_id;
  if (operation_id === undefined) return { ok: true };
  if (repo === undefined) {
    return {
      ok: false,
      error: {
        error: OPERATION_REGISTRY_UNWIRED_CODE,
        message: 'This server advertises operation idempotency but has no registry wired; refusing rather than '
          + 'accepting a recovery attempt it cannot protect.',
      },
    };
  }
  const verdict = repo.admit(userId, operation_id, {
    recording_id: start.recording_id,
    range_start_sample: start.range_start_sample,
    range_end_sample: start.range_end_sample,
    attempt_kind: start.attempt_kind,
    mode: start.mode,
  }, at);
  if (verdict.outcome === 'conflict') {
    return {
      ok: false,
      error: {
        error: OPERATION_CONFLICT_CODE,
        message: 'This operation id was already used for a different recording or range; '
          + 'the original registration is unchanged and this frame was not accepted.',
      },
    };
  }
  return { ok: true, operation_id, registered: verdict.outcome };
}
