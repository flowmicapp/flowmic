// Card RC-1a - THE ONE PREDICATE THAT MAY LICENSE DELETING A USER'S AUDIO.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//     section "Chose" 3 - the cleanup threshold, decided under owner authority
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A5-3 (the three preconditions), A6-3 (the ORDER), A7-1 (coverage receipt
//     levels L1/L2/L3 and versioning), E21/E48 (what justDone does not prove)
//   apps/mobile/lib/src/stt/stt_stream.dart - CoverageReceipt, the wire half
//
// THE THRESHOLD, VERBATIM FROM THE RULING
//
//   (i)   the coverage receipt is L2-complete: `fed_frames` equals what this
//         phone emitted for THIS attempt, `seq_gaps == 0`, `drops == 0`, and
//         the receipt's version is one this build recognises;
//   (ii)  the session ended on a NORMAL terminal final - not an auto-stop, not
//         a watchdog teardown, not a timeout;
//   (iii) the result row's persisted commit has been awaited AND the row was
//         read back out of persistent storage.
//
// Miss any one and the answer is `settled_unverified`: the bytes are KEPT, the
// job is not retried automatically, and the TTL sweep may not take it.
//
// WHY A SEPARATE MODULE FOR THREE BOOLEANS. Two callers, and the second one is
// the point: the live path (card LS-1b's `settleSegment` seam) has to use the
// SAME predicate as recovery, or the product ends up with two answers to
// "may these bytes go" and the weaker one wins by accident. A6-3 spells that
// out; the audit's own headline defect shape is one value answering two
// questions, and this is its filesystem-shaped cousin.
//
// WHAT IT REFUSES TO ANSWER. Whether the transcription is CORRECT. A5-4:
// there is no machine judgement for that, and this file must never grow one
// (no confidence threshold, no text-length heuristic). `fed_frames` matching
// is a count, and A7-1 says in its own words that a count cannot prove
// content - it is here as one NECESSARY condition, never a sufficient one.

import 'package:flutter/foundation.dart';

import '../stt/stt_stream.dart' show CoverageReceipt;
import 'recovery_identity.dart';

/// Coverage-receipt versions this build knows how to read.
///
/// A7-1: an unrecognised version is treated as NO RECEIPT, never as a weaker
/// proof to lean on. A newer server may mean something different by the same
/// counter names, and "we did not understand it" must not decay into "it
/// looked fine".
const Set<int> kSupportedCoverageReceiptVersions = <int>{1};

/// Why a settle was refused. One value per reason so a manifest attempt record
/// and a diagnostic line can both say which of the three conditions missed -
/// "not settled" alone is the answer that makes the next person re-derive it.
enum RecoverySettleRefusal {
  /// No receipt on the terminal final at all (an old server, or a relay that
  /// stripped it).
  noReceipt,

  /// The receipt arrived with a `coverage_receipt_version` this build does not
  /// recognise. Treated exactly as [noReceipt] would be - see the constant.
  receiptVersionUnknown,

  /// The receipt is about a different attempt or a different range than the
  /// one we are settling. A receipt pinned to the wrong stretch is worse than
  /// none: it is a proof of the wrong thing.
  receiptMismatch,

  /// `fed_frames` != the frames this attempt emitted.
  frameCountMismatch,

  /// `seq_gaps > 0` or `drops > 0`.
  gapsOrDrops,

  /// `ended_normally == false`, or the local FSM never reached its terminal
  /// final (a stall, a watchdog, the 20 s latch expiring).
  notEndedNormally,

  /// The row was never handed to persistence, its write failed, or the
  /// read-back did not find it.
  rowNotPersisted,

  /// The attempt's terminal final carried no words at all - A5-4's "empty
  /// result". The bytes are KEPT and the recording stays on the pending list
  /// with its own sentence, because "the engine produced nothing" is not a
  /// transcription and must never license a delete.
  emptyResult,

  /// The server this attempt ran against may not license deletes at all
  /// (gate tier B, A7-3).
  serverTierKeepsBytes,
}

/// Everything the predicate is allowed to look at. A record rather than eight
/// parameters so a caller cannot pass them in the wrong order, and so a test
/// can flip exactly one.
@immutable
class RecoverySettleInputs {
  const RecoverySettleInputs({
    required this.sent,
    required this.framesEmitted,
    required this.receipt,
    required this.resultText,
    required this.endedOnTerminalFinal,
    required this.rowPersistedAndReadBack,
    required this.serverMayDelete,
  });

  /// The identifiers THIS attempt put on `audio:start`. The pin below compares
  /// the receipt's echo against these, so a leg that sent fewer of them (the
  /// live press: no range end) is checked against what it actually sent rather
  /// than against a range somebody re-derived here.
  final StartEcho sent;

  /// Frames THIS attempt put on the wire. Held by the caller because it is the
  /// caller that emitted them; asking the receipt for both sides of the
  /// comparison would compare a number with itself.
  final int framesEmitted;

  /// The receipt off the terminal `stt:final`, or null when there was none.
  final CoverageReceipt? receipt;

  /// A5-4 - THE WORDS THE TERMINAL FINAL ITSELF CARRIED, or null when this
  /// attempt never received one.
  ///
  /// 🔴 IT IS THE FINAL'S OWN `text`, NEVER THE ROW'S. MEASURED
  /// 2026-09-06 (drill B-7, a 3 s recording of a quiet room): the server's
  /// silence gate emitted `stt:final {"text":"","empty_reason":"heard_no_words"}`
  /// while an earlier `stt:interim {"text":"."}` stayed in the slot -
  /// `SegmentBuffer.put` keeps a prior interim when a finalising frame carries
  /// nothing - so the ROW that reached the PC read ".". A predicate fed the
  /// row's text would have called that a transcription and released the audio,
  /// which is exactly what happened. The engine's own statement is the only
  /// honest input here.
  final String? resultText;

  /// Condition (ii). True ONLY when the FSM reached its terminal final
  /// (`SessionState.justDone` via `onSttFinal`) - the audit's E21/E48: a
  /// stall and a watchdog both also come to rest, and neither transcribed
  /// anything.
  final bool endedOnTerminalFinal;

  /// Condition (iii). The caller awaited the persisted-commit handle AND found
  /// the row again by reading persistent storage. Two facts, deliberately
  /// collapsed by the CALLER rather than here, because "the future completed"
  /// and "the row is there" are questions only the store can answer.
  final bool rowPersistedAndReadBack;

  /// Gate tier A only. See recovery_gate.dart.
  final bool serverMayDelete;
}

/// The verdict. [refusals] is empty exactly when [mayDeleteBytes] is true.
@immutable
class RecoverySettleDecision {
  const RecoverySettleDecision(this.refusals);

  final List<RecoverySettleRefusal> refusals;

  bool get mayDeleteBytes => refusals.isEmpty;

  /// A5-3's name for the other outcome. Kept as a getter rather than a second
  /// boolean so nothing can ever report both.
  bool get settledUnverified => refusals.isNotEmpty;

  /// Card LK-1 — was the ONLY thing standing between this recording and a
  /// delete the fact that this server issues no coverage receipts?
  ///
  /// True when the refusal set is exactly 「there was no receipt」 plus, on a
  /// tier-C server, 「this tier may not license deletes」 — and NOTHING else.
  /// Every local condition therefore held: a normal terminal final on both
  /// sides, a non-empty result, a row read back out of storage.
  ///
  /// 🔴 IT IS NOT ENOUGH ON ITS OWN, AND THE CALLER SUPPLIES THE OTHER HALF.
  /// [RecoverySettleRefusal.noReceipt] also fires when a server that ADVERTISES
  /// `recovery.coverage_receipt` sends a final without one — which is an
  /// anomaly about that exchange, not a property of the deployment, and must
  /// keep the `settled_unverified` sentence. `settleLiveRecording` ANDs this
  /// with `gate.coverageReceipt == false`.
  ///
  /// ⚠️ A tier-B server (`serverTierKeepsBytes` alone, receipt complete) is
  /// deliberately NOT this: its words came back proven and the audio is kept
  /// as a policy, which is `PendingRecoveryState.settledServerKeepsAudio`'s
  /// own sentence.
  bool get keptOnlyForMissingReceipt =>
      refusals.contains(RecoverySettleRefusal.noReceipt) &&
      refusals.every((RecoverySettleRefusal r) =>
          r == RecoverySettleRefusal.noReceipt ||
          r == RecoverySettleRefusal.serverTierKeepsBytes);

  /// Machine-readable, for the manifest attempt record and the diag line.
  String get reasonCode => refusals.isEmpty
      ? 'settled'
      : refusals.map((RecoverySettleRefusal r) => r.name).join('+');

  @override
  String toString() => 'RecoverySettleDecision($reasonCode)';
}

/// The ruling, as code. ALL refusals are collected rather than short-circuited:
/// a stretch that missed two conditions and is reported as missing one sends
/// the next reader to fix half of it.
///
/// CALLERS - EXACTLY TWO, AND A TEST SAYS SO
/// (`test/live_settle_has_call_site_test.dart` greps for them):
///   · `RecoveryJournalLeg._finish` (session/recovery_leg_settle.dart, a
///     `part` of recovery_journal_leg.dart)
///   · `settleLiveRecording` (session/live_settle.dart), card LS-1b
/// That is the reason this is a free function over a record and not a method on
/// the recovery queue.
RecoverySettleDecision evaluateRecoverySettle(RecoverySettleInputs i) {
  final List<RecoverySettleRefusal> out = <RecoverySettleRefusal>[];

  // (i) the coverage receipt, L2-complete.
  final CoverageReceipt? r = i.receipt;
  if (r == null) {
    out.add(RecoverySettleRefusal.noReceipt);
  } else if (!kSupportedCoverageReceiptVersions.contains(r.version)) {
    out.add(RecoverySettleRefusal.receiptVersionUnknown);
  } else {
    // The echoes are optional on the wire, so a NULL echo cannot be read as
    // agreement - it is the absence of the pin, and the identity is exactly
    // what the pin is for. A receipt that names a DIFFERENT attempt or range is
    // a mismatch either way. `StartEcho.matches` compares NULL TO NULL as
    // agreement, which is not a loophole: an old relay strips every one of
    // these keys at once, so a leg that sent an id gets null back and is
    // refused, and the only field a live press leaves unsent is the range end
    // it genuinely does not know yet.
    final bool pinned = i.sent.matches(
      recordingId: r.recordingId,
      attemptId: r.attemptId,
      rangeStartSample: r.rangeStartSample,
      rangeEndSample: r.rangeEndSample,
    );
    if (!pinned) out.add(RecoverySettleRefusal.receiptMismatch);
    if (r.fedFrames != i.framesEmitted) {
      out.add(RecoverySettleRefusal.frameCountMismatch);
    }
    if (r.seqGaps != 0 || r.drops != 0) {
      out.add(RecoverySettleRefusal.gapsOrDrops);
    }
  }

  // (ii) a normal terminal final, on BOTH sides. The receipt's own
  // `ended_normally` is the server's view and the FSM is ours; either one
  // saying no is a no, because they are describing two different ways the
  // same session can be cut short.
  if (!i.endedOnTerminalFinal || (r != null && !r.endedNormally)) {
    out.add(RecoverySettleRefusal.notEndedNormally);
  }


  // A5-4 - AN EMPTY RESULT KEEPS THE AUDIO, ALWAYS.
  //
  // 🔴 UNDER A DEAD ENGINE THIS IS THE ONLY THING BETWEEN THE USER AND
  // LOSING EVERYTHING. MEASURED 2026-09-06 with `FLOWMIC_FAULT_STT_STALL_MS`
  // armed (drill B-1 run 2) and again on a 10-minute recording (drill D-7): the
  // engine answers with an empty terminal final, every other condition holds -
  // the receipt is complete, the session ended normally, a row was persisted -
  // and 40 s and then 18.4 MiB of audio were deleted with nothing to show for
  // it. An engine that produces nothing produces it for EVERY recording, so
  // without this line one broken provider empties the phone.
  //
  // ⚠️ It is not a quality judgement and must never grow into one (the
  // ban at the head of this file still stands): "zero words" is the one
  // statement the engine makes about its own output that needs no
  // interpretation.
  final bool empty = (i.resultText ?? '').trim().isEmpty;
  if (empty) out.add(RecoverySettleRefusal.emptyResult);

  // (iii) the row is on disk and was found again.
  //
  // ⚠️ NOT ASKED OF AN EMPTY RESULT, and that is not a softening: there is
  // no row to look for. A recording nobody said anything into leaves nothing
  // behind (`settleLiveRecording` says the same at its `rowId == null` exit),
  // so stacking `rowNotPersisted` on top would report a missing row as a second
  // fault and make the refusal set say two things where one is true. Neither
  // arm may delete a byte either way - `emptyResult` is already in the set.
  if (!empty && !i.rowPersistedAndReadBack) {
    out.add(RecoverySettleRefusal.rowNotPersisted);
  }

  // A7-3 tier B: recovery ran, and still nothing may be deleted.
  if (!i.serverMayDelete) out.add(RecoverySettleRefusal.serverTierKeepsBytes);

  return RecoverySettleDecision(List<RecoverySettleRefusal>.unmodifiable(out));
}
