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

import 'dart:math' as math;

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

/// Card RC-2 — HOW FAST a recovery feed may hand audio to a real-time engine.
///
/// 🔴 THE MEASUREMENT THAT PUT IT HERE. [kRecoveryInFlightWindowBytes] bounds
/// memory, not speed: every interim reset it, so on CR-12-E the feed pushed
/// 428 s of audio in 4.3 s (about 100x real time). Soniox takes such a burst
/// without complaint and works through it at about 1.1-1.2x real time
/// (root-cause doc §1.6; `.local/rc-backfill/soniox-ack-probe.log` in the
/// lane-d slot), so the relay's flush cap fired long before the vendor was done
/// and the recording came back as its first 8 characters.
///
/// So the feed is paced by the engine's OWN processed position, which the
/// relay reports on every interim as `acked_audio_ms` ([SttInterim.ackedAudioMs])
/// in the clock we stamp chunks with: the feed may run at most
/// [maxAheadOfEngineMs] ahead of the last position reported. Between reports
/// the allowance grows at [fallbackRealTimeFactor] x real time, which is also
/// the whole rule against a relay that reports nothing (an older relay, or an
/// engine with no processed position).
///
/// ⚠️ WHY IT GROWS BETWEEN REPORTS INSTEAD OF HOLDING. A relay only speaks when
/// the engine has words: across a long pause its VAD gate withholds the silence
/// and hangs the leg up, so no interim comes however long the pause is. A hard
/// hold would stop every recovery that crosses a pause longer than the window,
/// and the pause costs the vendor nothing. An engine that keeps REPORTING
/// without advancing is the stuck one, and each report re-anchors the allowance
/// to the same position, so it holds; the leg's upload clock ends that wait.
///
/// ⚠️ NOT A FAKE REAL-TIME CADENCE. P1-3 (2) refuses 「drag a 30-minute
/// recording through at 200 ms per frame」, and this is not that: a healthy
/// engine sets the pace, and the fallback is twice real time in whole blocks.
///
/// ⚠️ 更正（RC-M，2026-09-24）：原为 `maxAheadOfEngineMs = 30000`. A feed 30 s
/// ahead of the engine means the relay's final comes ~30 s after `audio:stop`,
/// and the phone waited 15 s (root cause §3.2: 26.5–26.7 s on attempts 2–5). Now
/// 10 s ahead, the first block included ([allowedEndMs]), and the feed sends in
/// frames up to the allowance instead of waiting for a whole block to fit, so
/// the relay never sees [maxGapMs] of silence from a healthy recovery.
@immutable
class RecoveryPacing {
  const RecoveryPacing({
    this.maxAheadOfEngineMs = 10000,
    this.fallbackRealTimeFactor = 2.0,
  });

  /// Card RC-M — the longest a healthy feed leaves the wire silent between two
  /// sends. Under the relay's 3 s idle hang-up (server-core
  /// `stt/engine-idle-hangup.ts`), which re-feeds everything unflushed to a new
  /// leg. Informational: the frame-granular feed ([allowedEndMs] + a one-frame
  /// wait at [fallbackRealTimeFactor]) keeps it at a tenth of a second; only an
  /// engine that keeps reporting the SAME position holds longer, and that one
  /// is stuck (`uploadProgress` ends it).
  static const int maxGapMs = 1000;

  /// How far ahead of the engine's last reported position the feed may run.
  final int maxAheadOfEngineMs;

  /// How fast the allowance grows between reports, and against a relay that
  /// never reports, as a multiple of real time.
  final double fallbackRealTimeFactor;

  /// The furthest audio position (ms from the start of the range) the feed may
  /// have sent at [nowMs]. [ackedMs] null = no report yet in this attempt: the
  /// allowance then starts at 0 at [startedAtMs].
  int limitMs({
    required int? ackedMs,
    required int reportedAtMs,
    required int startedAtMs,
    required int nowMs,
  }) {
    // ⚠️ 更正（Codex rc3 ⑧，2026-09-24）：原为 `ackedMs == null ? 0 : …` — with no
    // report the allowance restarted from zero after the first send's 10 s
    // ([allowedEndMs]), so the next frame waited ~5.1 s at 2x: past the relay's
    // 3 s idle hang-up. No report reads as an engine at 0, the lead included.
    final int anchorPos = (ackedMs ?? 0) + maxAheadOfEngineMs;
    final int anchorWall = ackedMs == null ? startedAtMs : reportedAtMs;
    final int grown = ((nowMs - anchorWall) * fallbackRealTimeFactor).floor();
    return anchorPos + math.max(0, grown);
  }

  /// How long to wait before sending the block that ends at [endMs], given the
  /// current [limitMs]; 0 = send now. [sentMs] 0 = the first block, which never
  /// waits (nothing is in flight yet).
  int waitMs({required int sentMs, required int endMs, required int limitMs}) {
    if (sentMs == 0 || endMs <= limitMs) return 0;
    return ((endMs - limitMs) / fallbackRealTimeFactor).ceil();
  }

  /// Card RC-M — how far (ms from the start of the range) the feed may send
  /// now: the allowance, and for the first send at least [maxAheadOfEngineMs]
  /// (nothing is in flight yet, and the engine is at 0).
  int allowedEndMs({required int sentMs, required int limitMs}) =>
      sentMs == 0 ? math.max(limitMs, maxAheadOfEngineMs) : limitMs;
}

/// The production pacing; see [RecoveryPacing].
const RecoveryPacing kRecoveryPacing = RecoveryPacing();

/// How often a paced wait re-reads the clock, so a report that raises the
/// allowance is noticed without waiting out the whole computed gap.
const Duration kRecoveryPacePoll = Duration(milliseconds: 250);

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

/// Card RC-G — what one session key still owes, in journal bytes.
@immutable
class SessionDebtBytes {
  const SessionDebtBytes({required this.pendingBytes, required this.outageBytes});

  final int pendingBytes;

  /// How much of [pendingBytes] was recorded while the link (or the engine)
  /// was down — the same test [RecoveryLegOutcome.outagePendingBytes] sums.
  final int outageBytes;
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
    this.bySession = const <String, SessionDebtBytes>{},
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

  /// Card RC-G — [pendingBytes] and [outagePendingBytes] again, split by the
  /// session key each recording was minted under
  /// (`RetainedAudioSpill.sessionKeyOf`; for a continuous recording that key
  /// IS the article id).
  ///
  /// 🔴 THE TOTALS ABOVE ANSWER 「how much does this phone owe」; this answers
  /// 「how much does THIS piece owe」. The article page used to print the first
  /// as if it were the second — 「断网时录下的 10:51 还在转写」 on a piece that
  /// owed 1:35 (CR-12-E re-run, root-cause §5.5).
  final Map<String, SessionDebtBytes> bySession;
  final int needsManual;
  final int settledUnverified;

  /// True when the caller should stop this sweep (a press took the session, or
  /// the link went). The debt stays on disk and the next edge asks again.
  final bool stopEarly;
}
