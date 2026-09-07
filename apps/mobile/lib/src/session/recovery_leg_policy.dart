// Card RC-1a - THE JOURNAL LEG'S TUNEABLES AND ITS RESULT TYPE.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     P1-3 (bounded streaming; FOUR separate timeouts, none of which may let
//     an interim stream extend forever), A9's 700-line discipline
//
// Split out of recovery_journal_leg.dart for the 700-line rule, and the cut is
// where the repo's precedent puts it: everything here is a VALUE - a knob or a
// result - and nothing here does anything. The leg re-exports this file, so no
// importer had to change.

import 'package:flutter/foundation.dart';

import '../ptt/ptt_session.dart' show kBackfillChunkBytes;
import 'recovery_gate.dart';

/// The server's verdict when a recovery `audio:start` reused an `operation_id`
/// while describing different audio (owner-approved 2026-09-06; producer
/// apps/server-core/src/socket/handlers/audio-start-operation.ts
/// `admitOperation`). Mirrors `ERROR_CODES.AUDIO_OP_BINDING_CONFLICT` — the
/// phone cannot import TS.
///
/// 🔴 IT IS A TERMINAL VERDICT ON THIS ATTEMPT AND NOT ON THE RECORDING. The
/// bytes are untouched, the earlier registration stands, and the next eligible
/// pass runs a whole new attempt with a whole new operation id — which
/// `RecoveryJournalLeg._attempt` mints unconditionally, so there is no path on
/// which this leg re-sends the operation that was just refused. The
/// five-attempt auto budget still governs how many of those there are.
///
/// ⚠️ WHY IT IS NAMED HERE RATHER THAN COMPARED INLINE: the string is the only
/// thing binding this file to the server's registry, and a bare literal buried
/// in a listener is the shape that let `EMAIL_VERIFY_GRACE_EXPIRED` reach a
/// user's screen as a raw identifier. Its copy face is
/// `AppStrings.sttStallOpBindingConflict`.
const String kAudioOpBindingConflictCode = 'AUDIO_OP_BINDING_CONFLICT';

/// How much PCM one disk read pulls in. 64 wire frames = 12.8 s of audio.
///
/// ⚠️ A BOUND, NOT A PROMISE. It exists so a thirty-minute recording is never
/// held whole (P1-3); the exact value is a memory/syscall trade nobody has
/// measured on a device, and it is a parameter for that reason.
const int kRecoveryReadBlockBytes = 64 * kBackfillChunkBytes;

/// P2 (round-four drill) — how many bytes may be OUT ON THE WIRE and unconfirmed
/// before the feed stops reading more off disk.
///
/// 🔴 THE MEASUREMENT THAT PUT IT HERE. Feeding a 38.6 MiB recording back over
/// LAN to a server that stalled cost PSS +45.5 MB — very nearly the whole file
/// — even though [kRecoveryReadBlockBytes] means the file is never read whole.
/// The holder is not our loop: `socket.io` accepts every `emit` and buffers it,
/// so `feedBackfillBlock` returning a count proves only that the CALL was
/// accepted (its own doc says so), and a stalled server produced a queue that
/// grew until the file ran out.
///
/// ⚠️ IT IS PACED BY THE ENGINE, NOT BY A FLUSH, BECAUSE THERE IS NO FLUSH.
/// Nothing in `SocketCore` or the socket.io client reports 「that frame left the
/// device」, and putting an ack on `audio:chunk` is a protocol change. The one
/// honest signal available is the inbound stt traffic the server produces from
/// the audio it has actually consumed — coarse, and late by an engine's worth
/// of latency, which is why the window is a megabyte and a half rather than a
/// block. A sleep long enough to 「feel like」 pacing would bound nothing at all:
/// a stalled server does not go faster because we waited.
///
/// The value is 8 read blocks ≈ 1.6 MiB ≈ 100 s of audio, so a healthy engine
/// (interims every few seconds) never reaches it and the feed is unchanged.
const int kRecoveryInFlightWindowBytes = 8 * kRecoveryReadBlockBytes;

/// The four timeouts P1-3 asks for, separated because they mean four different
/// things and their remedies differ.
///
/// 🔴 THE ONE THING THEY MUST NOT DO, TOGETHER OR SEPARATELY, IS LICENSE A
/// DELETE. Every expiry below ends the attempt as a FAILURE, the bytes stay,
/// and the job backs off. That is the same rule the old single 20 s latch
/// carried; what changed is that one number no longer answers four questions.
@immutable
class RecoveryTimeouts {
  const RecoveryTimeouts({
    this.uploadProgress = const Duration(seconds: 30),
    this.engineProgress = const Duration(seconds: 45),
    this.noProgress = const Duration(seconds: 60),
    this.totalBudgetBase = const Duration(minutes: 2),
    this.totalBudgetPerAudioMinute = const Duration(minutes: 2),
  });

  /// Longest gap allowed between two blocks reaching the socket. Answers 「is
  /// the UPLOAD moving」 and nothing else.
  final Duration uploadProgress;

  /// Longest gap allowed between two inbound stt frames once the upload is
  /// done. Answers 「is the ENGINE moving」.
  ///
  /// 🔴 IT IS A GAP, NOT A DEADLINE, which is what lets a long recording take
  /// as long as it honestly takes - and [totalBudget] is what stops an interim
  /// stream from extending that forever (P1-3 (3)).
  final Duration engineProgress;

  /// Nothing at all has moved - no block out, no frame in.
  final Duration noProgress;

  /// Total budget = [totalBudgetBase] + [totalBudgetPerAudioMinute] per minute
  /// of audio. Proportional because a 30-minute recording legitimately takes
  /// longer than a 30-second one, and a fixed number would have to be either
  /// useless or wrong.
  final Duration totalBudgetBase;
  final Duration totalBudgetPerAudioMinute;

  Duration totalBudgetFor(Duration audio) =>
      totalBudgetBase +
      Duration(
          microseconds: (totalBudgetPerAudioMinute.inMicroseconds *
                  (audio.inMilliseconds / 60000.0))
              .round());
}

/// What one pass of the journal leg did. Read by [BackfillRunner] for the
/// progress face; card RC-1b renders the counts.
@immutable
class RecoveryLegOutcome {
  const RecoveryLegOutcome({
    required this.tier,
    required this.pendingBytes,
    required this.needsManual,
    required this.settledUnverified,
    required this.stopEarly,
    this.outagePendingBytes = 0,
  });

  static const RecoveryLegOutcome none = RecoveryLegOutcome(
    tier: null,
    pendingBytes: 0,
    needsManual: 0,
    settledUnverified: 0,
    stopEarly: false,
  );

  /// Null when no ack has been seen yet, so nothing was even evaluated.
  final RecoveryTier? tier;

  /// Bytes still owed by journal recordings after this pass.
  final int pendingBytes;

  /// Card LK-3 — how much of [pendingBytes] was recorded while the link was
  /// down (`JournalInterrupt.linkLoss`).
  ///
  /// 🔴 IT EXISTS SO ONE SENTENCE STOPS ANSWERING TWO QUESTIONS. The article
  /// page's banner says 「recorded offline, still being transcribed」, which was
  /// written when an outage was the only way audio could be owed anything. It
  /// is now shown for a recording the user merely paused, or for one whose
  /// receipt never came — 「断网时录下的 26s 还在转写」 with the network never
  /// having dropped (observed 2026-09-07). A count, not a flag, because the
  /// legacy face contributes bytes of its own and the caller sums them.
  final int outagePendingBytes;
  final int needsManual;
  final int settledUnverified;

  /// True when the caller should stop this sweep (a press took the session, or
  /// the link went). The debt stays on disk and the next edge asks again.
  final bool stopEarly;
}
