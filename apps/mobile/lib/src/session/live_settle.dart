// Card LS-1b — WHAT HAPPENS TO A HEALTHY LIVE RECORDING'S AUDIO.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md — §Chose 3 (the threshold), §Chose 4 O-1 (success ⇒ delete)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A5-3, §A6-3 (the ORDER), §A9 E25, §A10-0 (this card is a prerequisite of
//     turning first-frame storage on)
//   session/recovery_settle.dart — THE predicate, shared with the recovery leg
//   session/recovery_journal_leg.dart `_finish` — the call shape this mirrors
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// With the journal face on, every recording writes its bytes from the first
// frame. The recovery queue settles the ones that needed recovering; NOTHING
// settled the ones that simply worked. So a phone whose every recording
// succeeds accumulates until the O-2 ceiling (512 MiB, about nine half-hour
// recordings) and then starts refusing to keep audio at all. The healthy path
// had no exit.
//
// ── WHAT IT MAY NOT BECOME ──────────────────────────────────────────────────
//
// 🔴 A SECOND PREDICATE. The three conditions are `evaluateRecoverySettle`'s and
// this file only gathers their inputs. A6-3 asks for one answer to 「may these
// bytes go」, and the weaker of two answers is the one that wins by accident.
//
// 🔴 A DELETE TRIGGERED BY `justDone`. E21/E48: the FSM comes to rest on a
// stall and on a watchdog teardown too, and neither of those transcribed
// anything. What licenses a settle here is a REAL TERMINAL FINAL — the frame,
// not the state it leaves behind — plus a receipt about it and a row on disk.
// `live_settle_has_call_site_test.dart` greps for exactly that.

import 'dart:async';

import '../audio/retained_audio_spill.dart';
import '../diag/diag_log.dart';
import '../ptt/ptt_session.dart';
import '../signaling/state_machine.dart';
import '../stt/stt_stream.dart' show CoverageReceipt;
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import 'recovery_backoff.dart' show RecoveryQueueState;
import 'instance_probe.dart' show ServerChannel;
import 'recovery_gate.dart';
import 'recovery_identity.dart';
import 'recovery_settle.dart';

/// Settle the live recording that [receipt]'s terminal final just concluded.
///
/// CALLER — EXACTLY ONE: `_settleSpan` (session/chat_utterance_settle.dart), on
/// the terminal final only. See the block at the foot of this file for why a
/// soft-segment final may not reach here.
///
/// [rowId] is the row that final produced. A `null` row is not settled at all
/// (not even as `settled_unverified`): a recording that produced no words is
/// one the recovery queue may still legitimately re-feed, and stamping it
/// `settled_unverified` would take that option away while deleting nothing.
///
/// Returns the decision so a test can assert on it; production ignores it.
Future<RecoverySettleDecision?> settleLiveRecording({
  required PttSession session,
  required TimelineStore timeline,
  required CoverageReceipt? receipt,
  required String? finalText,
  required String? rowId,
  bool Function()? metered,
  LegacyServerVerifier legacyVerifier = const DenyAllLegacyServerVerifier(),
}) =>
    _settleLive(
      session: session,
      timeline: timeline,
      receipt: receipt,
      resultText: finalText,
      rowIds: rowId == null ? const <String>[] : <String>[rowId],
      metered: metered,
      legacyVerifier: legacyVerifier,
    );

/// Card RC-B — a live press or long recording whose terminal final carried no
/// words, after earlier spans of it had already become rows.
///
/// CALLER — EXACTLY ONE: `_handleTerminalFinal` (session/chat_utterance.dart),
/// in its empty-text branch when rows already settled (`fromIdx > 0`).
/// `live_settle_has_call_site_test.dart` pins it there.
///
/// 🔴 THE SHAPE (CR-12-E rerun, RB): the last sentence was cut into a row by a
/// pause, the user stayed silent, then pressed stop ⇒ `stt:final {text:'',
/// is_segment:false}` with a complete receipt. That branch used to `return`,
/// so no live settle ran, the SD-2 stamp expired after
/// `kLiveSettlePendingGraceMs`, and the recovery queue took the WHOLE
/// recording, from byte 0, as owed: on a tier-A server it would be
/// transcribed again, filed into the article a second time, and billed again.
///
/// 🔴 THE RESULT IS THE ROWS IT PRODUCED, not the last stretch the terminal
/// final covers. MAIN ruling 2026-09-24 (root-cause rerun §10-2) licenses the
/// delete only when all four hold: the terminal final is empty (checked here),
/// the receipt's `fed_frames` equals the frames sent and it says
/// `ended_normally` (both checked by the ONE predicate, with the rest of its
/// conditions), and at least one row of THIS recording is persisted and read
/// back. [evaluateRecoverySettle] is not touched: its `emptyResult` refusal
/// still stands for every caller, because what changes is only the result this
/// entry hands it — the recording's own rows, never an empty one.
///
/// ⚠️ 更正（RC-B follow-up，2026-09-24，MAIN ruling）：原为 long recordings only
/// (`settleLongRecordingSilentTail`), with the ordinary press left to 「today's
/// behaviour」 — which production reaches: the reconnect ack advertises
/// recovery, so such a press was transcribed again, filed twice and billed
/// again. An ordinary press now settles the same way on [pressRowIds]: the rows
/// `_settleSpan` recorded for the live attempt [pressRecordingId] names. A long
/// recording still answers with its article's rows.
///
/// Returns null (nothing written) when this is not a live final, and when the
/// recording has no row at all.
Future<RecoverySettleDecision?> settleSilentTail({
  required PttSession session,
  required TimelineStore timeline,
  required CoverageReceipt? receipt,
  required String? finalText,
  String? pressRecordingId,
  List<String> pressRowIds = const <String>[],
  bool Function()? metered,
  LegacyServerVerifier legacyVerifier = const DenyAllLegacyServerVerifier(),
}) async {
  // Condition 1 — a final that carried words is `settleLiveRecording`'s case.
  if ((finalText ?? '').trim().isNotEmpty) return null;
  final LiveAudioAttempt? attempt = session.audio.retainedAudio?.liveAttempt;
  // Neither a recovery placing rows nor a recovery session is a live final.
  if (attempt == null ||
      session.articles.isReplaying ||
      session.openSessionRange != null) {
    return null;
  }
  final String? article = session.articles.liveArticleId;
  final List<TimelineEntry> rows;
  if (article != null &&
      RetainedAudioSpill.sessionKeyOf(attempt.recordingId) == article) {
    // A long recording is filed under its article id (`beginContinuous`).
    rows = <TimelineEntry>[...articleMembersOf(timeline, article)];
  } else {
    // An ordinary press: the rows recorded for THIS live attempt, and only if
    // the ledger names this attempt (a stale list belongs to another press).
    if (pressRecordingId != attempt.recordingId) return null;
    rows = <TimelineEntry>[
      for (final String id in pressRowIds)
        if (timeline.findById(id) case final TimelineEntry e) e,
    ];
  }
  if (rows.isEmpty) return null;
  final List<TimelineEntry> newestFirst = rows.reversed.toList();
  if (article != null) {
    newestFirst.sort((TimelineEntry a, TimelineEntry b) =>
        (b.articleOffsetMs ?? 0).compareTo(a.articleOffsetMs ?? 0));
  }
  return _settleLive(
    session: session,
    timeline: timeline,
    receipt: receipt,
    // What it produced. Only its non-emptiness is read (the predicate bans any
    // other judgement of the words).
    resultText: newestFirst.reversed.map((TimelineEntry e) => e.displayText).join('\n'),
    // Newest first: the first one read back becomes `resultRef` (condition 4).
    rowIds: <String>[for (final TimelineEntry e in newestFirst) e.id],
    metered: metered,
    legacyVerifier: legacyVerifier,
  );
}

/// The one body both entries share. [rowIds] are the candidate result rows, in
/// the order they are tried; the first persisted and read back is the result
/// (condition (iii)). Empty ⇒ nothing is settled.
Future<RecoverySettleDecision?> _settleLive({
  required PttSession session,
  required TimelineStore timeline,
  required CoverageReceipt? receipt,
  required String? resultText,
  required List<String> rowIds,
  bool Function()? metered,
  required LegacyServerVerifier legacyVerifier,
}) async {
  final RetainedAudioSpill? spill = session.audio.retainedAudio;
  if (spill == null || !spill.retainFromFirstFrame) return null;
  final LiveAudioAttempt? attempt = spill.liveAttempt;
  if (attempt == null || rowIds.isEmpty) return null;
  // 🔴 A STAMP WITH NO FRAME COUNT IS A RECORDING THAT IS STILL RUNNING, and
  // comparing a receipt against a moving number is how a settle comes out right
  // by luck. `endRecording` is what closes it; if it has not run, this final
  // belongs to something we are not finished with.
  final int? framesEmitted = attempt.framesEmitted;
  if (framesEmitted == null) return null;
  // 🔴 THIS FINAL MAY BELONG TO A RECOVERY ATTEMPT, NOT TO THE PRESS.
  //
  // `_settleSpan` runs on EVERY terminal final, and the recovery leg's
  // re-transcription produces one through the same inbound path - it has no way
  // to mark its own. MEASURED 2026-09-06 (drill B-2, a 3 s link loss mid-press):
  //
  //   audio.live.settle     attempt_id=run-...-a1        decision=receiptMismatch
  //   audio.recovery.settle attempt_id=a-hm15a10yl1-0    decision=settled
  //
  // four milliseconds apart, on ONE recording. The receipt echoed the RECOVERY
  // attempt's id, so the predicate correctly reported `receiptMismatch` - about
  // a comparison that should never have been made - and then this leg's own
  // journal handle wrote `settled_unverified` over the recovery leg's `settled`,
  // taking the auto_retry attempt's `outcome` with it (the two legs hold
  // separate handles, so the last commit wins).
  //
  // The echo is the discriminator: the server puts back the `attempt_id` and
  // `recording_id` this attempt sent on `audio:start`. A receipt naming another
  // attempt is not this press's conclusion, so there is nothing here to settle -
  // the leg that opened that attempt settles it.
  //
  // ⚠️ NULL ECHOES ARE NOT A MATCH AND NOT A MISMATCH. An older relay
  // strips the identifiers, so nothing here can tell the two legs apart; the
  // predicate then refuses on `noReceipt` and the bytes stay, which is the safe
  // direction and the pre-existing behaviour.
  final CoverageReceipt? r = receipt;
  final bool namesAnotherAttempt = r != null &&
      ((r.attemptId != null && r.attemptId != attempt.attemptId) ||
          (r.recordingId != null && r.recordingId != attempt.recordingId));
  if (namesAnotherAttempt) {
    diag('audio.live.settle_skipped_other_attempt', <String, Object?>{
      'recording_id': attempt.recordingId,
      'attempt_id': attempt.attemptId,
      'receipt_recording_id': r.recordingId,
      'receipt_attempt_id': r.attemptId,
    });
    return null;
  }

  // 🔴 CARD RC-3 — A RECORDING THAT OWES ITS TAIL IS NOT THIS PATH'S TO SETTLE.
  // It ended with the link or the engine down (`RetainedAudioSpill
  // .noteOwedTail`), so part of it was never heard by any engine — and the
  // relay DID take every frame, so the receipt can look complete. Settling
  // here would delete, or park as `settled_unverified`, audio whose words do
  // not exist anywhere. The recovery leg owns it from its transcribed prefix.
  if (spill.owesTail(attempt.recordingId)) {
    diag('audio.live.settle_skipped_owed_tail', <String, Object?>{
      'recording_id': attempt.recordingId,
      'attempt_id': attempt.attemptId,
    });
    return null;
  }

  // (ii) — the local half. The frame said `is_segment:false` (the caller's
  // guard) AND the FSM took it: `onSttFinal` refuses anything that is not
  // PROCESSING, so `justDone` here means THIS final drove the transition. It is
  // one half of condition (ii); the receipt's own `ended_normally` is the
  // other, and the predicate ANDs them.
  final bool endedOnTerminalFinal =
      session.fsm.session == SessionState.justDone;

  // (iii) — two facts, in this order. The handle completes on failure too (its
  // own doc says so), so only the read proves anything survived.
  // Card RC-B — for a long recording's silent tail, the first of its rows that
  // is read back; the newest one when none is (it names the refusal's row).
  String rowId = rowIds.first;
  bool persisted = false;
  for (final String id in rowIds) {
    await timeline.awaitPersisted(id);
    if (await timeline.isPersisted(id)) {
      rowId = id;
      persisted = true;
      break;
    }
  }

  // A7-3 — the same server gate the recovery leg asks, and for the same reason:
  // a relay that cannot prove it honoured `delivery:'none'` and the receipt
  // fields may not license a delete, whichever leg produced the recording.
  // 🔴 NULL (not yet probed) READS AS METERED — the fail-closed direction the
  // journal leg's own comment measured.
  final RecoveryGateVerdict gate = evaluateRecoveryGate(
    caps: session.reconnect.serverCapabilities,
    metered:
        (metered ?? () => session.serverChannel.value != ServerChannel.lan)(),
    verifier: legacyVerifier,
  );

  final RecoverySettleDecision decision = evaluateRecoverySettle(
    RecoverySettleInputs(
      // What this press actually put on `audio:start` — no range end, because
      // a live press does not know where it will stop. See `StartEcho`.
      sent: StartEcho(
        recordingId: attempt.recordingId,
        attemptId: attempt.attemptId,
        rangeStartSample: kLiveRangeStartSample,
      ),
      framesEmitted: framesEmitted,
      receipt: receipt,
      // A5-4 - the FINAL's own words, not the row's. See
      // `RecoverySettleInputs.resultText` for the B-7 measurement that makes
      // the distinction load-bearing: a stale interim can leave the row with
      // text the engine never produced.
      // Card RC-B — for a long recording's silent tail this is its rows (see
      // `settleLongRecordingSilentTail` for why, and for the ruling).
      resultText: resultText,
      endedOnTerminalFinal: endedOnTerminalFinal,
      rowPersistedAndReadBack: persisted,
      serverMayDelete: gate.tier.mayDeleteBytes,
    ),
  );
  // Card LK-1 — THE THIRD OUTCOME, AND IT IS THE ORDINARY ONE ON TODAY'S
  // RELAY. A press that transcribed, delivered and left a row on disk against
  // a server that issues no receipts is not 「waiting to be transcribed」 and
  // is not 「we could not confirm your words」: it is finished, and its audio is
  // ordinary ballast. MEASURED 2026-09-07 (owner, phone 0.3.74 against relay
  // 0.3.71, which advertises no capabilities at all): four ordinary presses of
  // 4/5/9/7 s, every one transcribed and delivered, every one listed on the
  // pending screen under 「this server version cannot recover audio safely」.
  //
  // 🔴 BOTH HALVES ARE REQUIRED. `keptOnlyForMissingReceipt` says the refusal
  // set is only about the receipt; `!gate.coverageReceipt` says the SERVER told
  // us it cannot issue one. A server that advertises the capability and then
  // sends a final without a receipt is an anomaly about that exchange — it
  // keeps `settled_unverified`, stays on the list, and stays exempt from the
  // sweep.
  final bool noReceiptCapability = !gate.coverageReceipt;
  final String queueState = decision.mayDeleteBytes
      ? RecoveryQueueState.settled
      : (noReceiptCapability && decision.keptOnlyForMissingReceipt)
          ? RecoveryQueueState.transcribedUnverified
          : RecoveryQueueState.settledUnverified;
  diag('audio.live.settle', <String, Object?>{
    'recording_id': attempt.recordingId,
    'attempt_id': attempt.attemptId,
    'frames_emitted': framesEmitted,
    'fed_frames': receipt?.fedFrames,
    'decision': decision.reasonCode,
    'queue_state': queueState,
    'receipt_capability': gate.coverageReceipt,
    'row': rowId,
  });
  await spill.publishLiveSettle(
    attempt: attempt,
    rowId: rowId,
    reasonCode: decision.reasonCode,
    mayDelete: decision.mayDeleteBytes,
    attemptKindWire: RecoveryAttemptKind.live.wire,
    recoveryState: queueState,
  );
  return decision;
}

// ── 🔴 CONTINUOUS RECORDINGS SETTLE ONCE, AT THE END — NEVER PER SEGMENT ─────
//
// A long recording produces many soft-segment finals (`is_segment:true`) and
// exactly one terminal final. The unit of storage is the RECORDING: one
// journal, one manifest, one PCM file, opened by `AudioCapture.start` and
// closed on stop. A segment is the SERVER's unit — it is where the engine cut
// the transcript, and the phone cannot even name the byte offset it corresponds
// to (§A3-2a bans deriving one from the frame size).
//
// So 「settle segment N」 has no meaning on this face: there is nothing to delete
// but the whole file, and deleting it after the first segment would throw away
// the twenty-nine minutes still being recorded into it. That is the same
// conclusion E25 reached about the LEGACY per-segment verb, arrived at from the
// other end.
//
// The rule is enforced STRUCTURALLY, not by a guard in here: the only call site
// sits inside `if (!f.isSegment)` in `_settleSpan`, and
// `live_settle_has_call_site_test.dart` asserts that it still does.
