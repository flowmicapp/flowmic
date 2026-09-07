// Card RC-1a - HOW OFTEN, HOW MANY TIMES, AND WHEN TO STOP TRYING.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//     "Chose" 2 (O-9 乙): at most 5 automatic attempts per job, exponential
//     backoff capped at 30 minutes, then it becomes the user's move
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A6 R-3 (the queue's state is PERSISTED, not in memory) and R-4
//
// WHY THE NUMBERS ARE HERE AND NOT IN THE RUNNER. Under O-9 乙 a re-send is a
// re-RECOGNITION: the vendor is paid again even though the user is billed once.
// So the retry ceiling is a COST decision that the owner ruled on, and it must
// be readable in one place rather than inferred from a loop somewhere.
//
// 🔴 THE CEILING IS PER JOB, NOT PER SWEEP AND NOT PER PROCESS. Counting in
// memory would reset it on every relaunch, which is precisely the shape that
// turns "at most five" into "five per launch, forever" on a device that
// crashes. The count lives in the manifest (A6 R-3) and this file only does
// arithmetic on it.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../audio/retained_audio_manifest.dart';
import 'recovery_identity.dart';

/// Owner ruling: at most five AUTOMATIC attempts per job.
///
/// ⚠️ AUTOMATIC. A user pressing "try again" (card RC-1b) is
/// [RecoveryAttemptKind.userRetranscribe] and is not counted here - that is the
/// whole reason `attempt_kind` exists in the manifest and on the wire. A
/// ceiling that counted the user's own presses would take away the one route
/// that is left after the automatic route gives up.
const int kRecoveryMaxAutoAttempts = 5;

/// First backoff step.
const Duration kRecoveryBackoffBase = Duration(minutes: 1);

/// Owner ruling: the exponential series stops growing here.
const Duration kRecoveryBackoffCap = Duration(minutes: 30);

/// 1, 2, 4, 8, 16, then 30 forever. [failedAutoAttempts] is how many automatic
/// attempts have ALREADY failed, so the first retry waits [kRecoveryBackoffBase].
///
/// 🔴 ITS PRODUCTION CALLER IS ONE HOP AWAY, and the anchor is here because a
/// grep for this name alone finds only tests and reads as dead code:
///   recoveryBackoffFor -> [RecoveryJobStatus.nextEligibleAfterFailure] (below)
///     -> `recovery_journal_leg.dart`'s `_finish`, which writes the result to
///        the manifest as `nextEligibleAtMs` after an AUTO failure. Grep:
///        grep -rn "nextEligibleAfterFailure" apps/mobile/lib
Duration recoveryBackoffFor(int failedAutoAttempts) {
  if (failedAutoAttempts <= 0) return Duration.zero;
  // Shift rather than pow, and clamp the exponent before shifting: a manifest
  // that somehow carried a large attempt count would otherwise overflow into a
  // negative delay, i.e. into "retry immediately, forever".
  final int shift = math.min(failedAutoAttempts - 1, 20);
  final int ms = kRecoveryBackoffBase.inMilliseconds << shift;
  return ms >= kRecoveryBackoffCap.inMilliseconds || ms <= 0
      ? kRecoveryBackoffCap
      : Duration(milliseconds: ms);
}

/// Where one recording stands with the recovery queue. Persisted verbatim in
/// `RecordingManifest.recoveryState`.
///
/// 🔴 THE STRINGS ARE THE ON-DISK FORMAT. Renaming one silently reclassifies
/// every manifest a previous build wrote; an unrecognised value decodes to
/// [pending], which is the direction that retries rather than the direction
/// that forgets.
class RecoveryQueueState {
  /// Nothing has been decided. The default for every manifest ever written.
  static const String pending = 'pending';

  /// A7-3 tier C: the server cannot be trusted with this, so not one
  /// `audio:start` has been sent. 🔴 It is PERSISTED because the condition
  /// outlives the process - a phone that only ever meets old relays must not
  /// re-derive this from scratch on every launch and must be able to say so on
  /// screen (card RC-1b renders it).
  static const String awaitingServerCapability = 'awaiting_server_capability';

  /// The automatic budget is spent. The bytes stay; only a user action (card
  /// RC-1b) moves this.
  static const String needsManual = 'needs_manual';

  /// A5-3: we believe it worked and cannot prove it. Kept, NOT auto-retried,
  /// NOT swept by TTL. Distinct from [needsManual] because nothing is owed -
  /// the words are already rows.
  static const String settledUnverified = 'settled_unverified';

  /// Card LK-1 — the press transcribed, the row was read back, and the ONLY
  /// thing missing is a coverage receipt this server does not know how to
  /// issue.
  ///
  /// 🔴 SPLIT OUT OF [settledUnverified] BECAUSE THE TWO OWE THE USER
  /// DIFFERENT THINGS. `settled_unverified` is a statement about THIS
  /// recording — something we tried to confirm and could not — so it is listed
  /// on the pending screen and its bytes are exempt from the TTL. This one is
  /// a statement about the SERVER: nothing is owed, nothing is waiting, the
  /// words are in the timeline, and the audio is ordinary TTL-eligible ballast.
  /// Owner ruling O-2's exemption is for UNRECOVERED audio; conflating the two
  /// put every ordinary successful press on the 「waiting to be transcribed」
  /// list against relay 0.3.71 (observed 2026-09-07 on 0.3.74).
  ///
  /// ⚠️ NOT AUTO-RETRIED and NOT `settled`: the bytes stay until the sweep
  /// takes them, and until then they count against the cap like everything
  /// else.
  static const String transcribedUnverified =
      RecordingManifest.recoveryStateTranscribedUnverified;

  /// The three conditions held. `RecordingManifest.settled` is the flag the
  /// sweep reads; this is the human-readable twin of it.
  static const String settled = 'settled';

  static const Set<String> all = <String>{
    pending,
    awaitingServerCapability,
    needsManual,
    settledUnverified,
    transcribedUnverified,
    settled,
  };

  /// Has this recording reached a FINAL decision — words in hand, nothing owed?
  ///
  /// 🔴 THE TIER-C SWEEP ASKS THIS BEFORE IT STAMPS ANYTHING. Stamping
  /// `awaiting_server_capability` over one of these overwrites the only record
  /// of what actually happened, and the screen then says 「this server cannot
  /// recover audio safely」 about a recording that was transcribed and delivered
  /// (observed 2026-09-07). Pinned by
  /// `test/live_kept_audio_test.dart`'s tier-C cases.
  static bool isTerminalSettle(String state) =>
      state == settled ||
      state == settledUnverified ||
      state == transcribedUnverified;

  static String normalise(String? raw) =>
      raw != null && all.contains(raw) ? raw : pending;
}

/// The queue's view of one recording, derived from its manifest. A value type,
/// so the decision 「may I try this now」 is testable without a filesystem.
@immutable
class RecoveryJobStatus {
  const RecoveryJobStatus({
    required this.state,
    required this.failedAutoAttempts,
    required this.nextEligibleAtMs,
  });

  /// Derive from a manifest. Counts only [RecoveryAttemptKind.autoRetry]
  /// records that FAILED - a user's own retry never spends the automatic
  /// budget, and a successful attempt is not a failure to back off from.
  factory RecoveryJobStatus.fromManifest(RecordingManifest m) {
    int failed = 0;
    for (final JournalAttempt a in m.attempts) {
      if (a.kind == RecoveryAttemptKind.autoRetry.wire &&
          a.outcome != null &&
          a.outcome != JournalAttempt.outcomeSettled &&
          a.outcome != JournalAttempt.outcomeSettledUnverified) {
        failed += 1;
      }
    }
    return RecoveryJobStatus(
      state: RecoveryQueueState.normalise(m.recoveryState),
      failedAutoAttempts: failed,
      nextEligibleAtMs: m.nextEligibleAtMs,
    );
  }

  final String state;
  final int failedAutoAttempts;

  /// Wall clock, milliseconds since epoch. Null = no wait recorded.
  ///
  /// ⚠️ WALL CLOCK IS A REAL WEAKNESS AND IS STATED RATHER THAN HIDDEN: a
  /// device whose clock jumps backwards will wait longer than the ruling says,
  /// and one that jumps forwards will retry early. The alternative - a monotonic
  /// clock - does not survive the process death this field exists for, and
  /// retrying early costs one vendor call while never retrying costs the user
  /// their words. The failure direction is deliberate.
  final int? nextEligibleAtMs;

  /// The automatic budget is spent.
  bool get budgetExhausted => failedAutoAttempts >= kRecoveryMaxAutoAttempts;

  /// May an AUTOMATIC attempt start right now?
  ///
  /// 🔴 It does not consider the server tier: that is recovery_gate.dart's
  /// question and asking it twice is how two answers appear.
  bool mayAutoAttemptAt(int nowMs) {
    if (RecoveryQueueState.isTerminalSettle(state) ||
        state == RecoveryQueueState.needsManual) {
      return false;
    }
    if (budgetExhausted) return false;
    final int? due = nextEligibleAtMs;
    return due == null || nowMs >= due;
  }

  /// The state to persist after an automatic attempt failed.
  String stateAfterAutoFailure() => failedAutoAttempts + 1 >=
          kRecoveryMaxAutoAttempts
      ? RecoveryQueueState.needsManual
      : RecoveryQueueState.pending;

  /// When the next automatic attempt becomes due after a failure now.
  int nextEligibleAfterFailure(int nowMs) =>
      nowMs + recoveryBackoffFor(failedAutoAttempts + 1).inMilliseconds;

  @override
  String toString() => 'RecoveryJobStatus($state failed=$failedAutoAttempts '
      'due=$nextEligibleAtMs)';
}
