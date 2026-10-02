// NR-138 ① — HOW MANY TIMES THE LEGACY LEG MAY TRY ON ITS OWN, AND WHEN.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, NR-138 correction (2026-10-01) ①②
//     and its round-2 correction ①
//   apps/mobile/lib/src/session/recovery_backoff.dart (THE numbers, reused:
//     owner ruling O-9 乙's five automatic attempts and the 1, 2, 4, 8 … 30
//     minute series — a second copy here would be a second answer)
//   apps/mobile/lib/src/audio/retained_audio_legacy_retry.dart (the record)
//
// ── WHAT IS COUNTED ─────────────────────────────────────────────────────────
//
// ⚠️ 更正（NR-138 round 2, review B1, MAIN ruling）: round 1 counted only
// automatic starts that ended WITHOUT A CONCLUSION, so a recording with six
// healthy segments made six automatic `audio:start`s (the reviewer measured
// six through the production controller). The cap is now EVERY automatic start
// that reached the relay — a success, a kept-unverified result, an empty
// result, a stall, a lost link, a killed process alike: at most five per
// recording, across all of its segments. Only a begin refused before anything
// was sent (busy / no link / gate) spends nothing.
//
// The WAITS still follow failures only: 1, 2, 4, 8 minutes after the first,
// second, third, fourth failed start. A start that concluded sets no wait.
//
// Per SESSION (one retained recording), across all of its segment files, and
// for its whole life on this phone. Nothing resets it: not a reconnect, a
// restart, a new sweep, or a person pressing Re-transcribe (that press is
// `user_retranscribe` and never reads or writes this record).
//
// ── THE RESERVATION ─────────────────────────────────────────────────────────
//
// Written BEFORE `audio:start`. A reader that finds one it does not own counts
// it as a start AND a failed start, waiting from the reservation's own
// timestamp: either the process died with the attempt out, or a resolution
// write failed. Both are read in the direction that never sends more audio
// than the budget allows. The cost is that a success whose resolution could
// not be written is counted as a failure — written down here rather than
// discovered later.

import 'package:flutter/foundation.dart';

import '../audio/retained_audio_store.dart'
    show LegacyRetryRead, LegacyRetryRecord;
import 'recovery_backoff.dart';

/// NR-138 round 2 (review B3, MAIN ruling) — automatic starts for one legacy
/// recording are made only within this long after its FIRST automatic start.
/// *** billing — reviewable in isolation ***
///
/// 🔴 WHY SIX DAYS: the relay remembers an operation's metering claim for
/// `RECOVERY_RETENTION_MS` = 7 days (apps/server-core/src/db/schema-recovery.ts;
/// pruned daily by original `applied_at`). An automatic re-send of the same job
/// after the claim is gone is registered again and BILLED again (the review
/// measured 400/60,000 minutes instead of 200/60,000 after the real pruners
/// ran at +8 days). The derived operation id therefore buys 「billed once」
/// only inside that window, and the phone stops a day earlier. Pinned against
/// the relay constant by `legacy_retry_budget_test.dart` (it reads that file),
/// so the two numbers cannot drift apart silently.
///
/// ⚠️ WALL CLOCK, PERSISTED, AND READ CONSERVATIVELY: a stored first start in
/// the future, a clock now earlier than the latest recorded start, or a
/// record that has starts but no first time ⇒ the window is CLOSED, never
/// fresh. What it cannot see: a clock set back to a moment still later than
/// the latest start, which shortens the elapsed time it measures (the
/// residual is in the NR-138 audit-queue row).
///
/// ⚠️ Correction (NR-138 round 3, review B5 + F2, MAIN decision, 2026-10-01) —
/// the paragraphs above are kept as written; their billing argument no longer
/// holds the guarantee. (1) The relay now keeps a recovery operation's metering
/// claim (`usage_effects`, written once at its original `applied_at`) for 90
/// days (book 22 §4.11, branch `lane/nr138-nocharge`; the privacy policy's
/// per-use window); an unclaimed registry row (`recovery_operations`, pruned by
/// `last_seen_at`) still goes after seven days, and a re-send inside the 90
/// days finds the claim and is not debited. So this window is a COST / UX
/// bound — how long the phone keeps trying on its own — not what keeps a job
/// billed once. The relay's 90 days cover a clock set back by up to 84 days
/// (90 − this window's 6); a re-send after a larger rollback is billed again. (2) The 「what it
/// cannot see」 sentence had a consequence it did not name: a clock set back
/// past the one-day margin let an automatic re-send outlive the claim and
/// debit the same segment again (the review: relay day 8, phone day 5, 400 of
/// 60,000 ms). With the relay change live that re-send is still made, and is
/// not debited — as long as it reaches the relay within 90 days of the first
/// charge. (3) Round 3 (review B4): once the phone has OBSERVED the
/// route stopped it writes that down (`LegacyRetryRecord.autoStoppedAtMs`),
/// and no later clock value reopens it.
const Duration kLegacyAutoWindow = Duration(days: 6);

/// The legacy leg's view of one session, derived from its record.
@immutable
class LegacyRetryStatus {
  const LegacyRetryStatus._({
    required this.readable,
    required this.starts,
    required this.failedStarts,
    required this.nextEligibleAtMs,
    this.firstAutoStartAtMs,
    this.lastAutoStartAtMs,
    this.autoStoppedAtMs,
  });

  /// [ownInFlight] is the token of the runner whose attempt is out right now
  /// on THIS session, or null. Only that runner's reservation is in flight;
  /// any other reservation is an attempt whose ending was never written.
  factory LegacyRetryStatus.of(LegacyRetryRead read, {String? ownInFlight}) {
    final LegacyRetryRecord? r = read.record;
    if (r == null) return unwritable;
    final int? at = r.reservedAtMs;
    if (at == null || (ownInFlight != null && r.reservedBy == ownInFlight)) {
      return LegacyRetryStatus._(
        readable: true,
        starts: r.starts,
        failedStarts: r.failedStarts,
        nextEligibleAtMs: r.nextEligibleAtMs,
        firstAutoStartAtMs: r.firstAutoStartAtMs,
        lastAutoStartAtMs: r.lastAutoStartAtMs,
        autoStoppedAtMs: r.autoStoppedAtMs,
      );
    }
    final int failed = r.failedStarts + 1;
    final int due = at + recoveryBackoffFor(failed).inMilliseconds;
    final int? next = r.nextEligibleAtMs;
    return LegacyRetryStatus._(
      readable: true,
      starts: r.starts + 1,
      failedStarts: failed,
      nextEligibleAtMs: next == null || due > next ? due : next,
      // The reservation went out with these set; keep them, conservatively.
      firstAutoStartAtMs: r.firstAutoStartAtMs ?? at,
      lastAutoStartAtMs: at,
      autoStoppedAtMs: r.autoStoppedAtMs,
    );
  }

  /// The record could not be WRITTEN in this process (a reservation failed to
  /// reach disk), or could not be read. No automatic start can be accounted
  /// for, so none is made.
  static const LegacyRetryStatus unwritable = LegacyRetryStatus._(
    readable: false,
    starts: 0,
    failedStarts: 0,
    nextEligibleAtMs: null,
  );

  /// False when the record is there and cannot be read, or cannot be written:
  /// the history is lost or cannot be kept, and the automatic route stops
  /// rather than starting again from zero.
  final bool readable;

  /// Automatic starts that reached the relay, a stale reservation included.
  final int starts;

  /// Of [starts], the failed ones (they set the waits).
  final int failedStarts;

  /// Wall clock. Same deliberate weakness as `RecoveryJobStatus
  /// .nextEligibleAtMs`: a clock that jumps forward retries early.
  final int? nextEligibleAtMs;

  /// See [LegacyRetryRecord.firstAutoStartAtMs] / [kLegacyAutoWindow].
  final int? firstAutoStartAtMs;
  final int? lastAutoStartAtMs;

  /// See [LegacyRetryRecord.autoStoppedAtMs].
  final int? autoStoppedAtMs;

  /// NR-138 round 3 (review B4) — the stop was observed and written down.
  bool get autoStopped => autoStoppedAtMs != null;

  /// Five automatic starts have been made — of any outcome.
  bool get budgetExhausted => starts >= kRecoveryMaxAutoAttempts;

  /// When the six-day automatic window closes, or null before any start.
  int? get windowClosesAtMs {
    final int? first = firstAutoStartAtMs;
    return first == null ? null : first + kLegacyAutoWindow.inMilliseconds;
  }

  /// NR-138 round 2 (review B3) — is the automatic window closed at [nowMs]?
  /// Every doubt reads as CLOSED (see [kLegacyAutoWindow]).
  bool windowClosedAt(int nowMs) {
    final int? first = firstAutoStartAtMs;
    if (first == null) return starts > 0; // starts with no time: unknown
    if (first > nowMs) return true; // stored in the future
    final int? last = lastAutoStartAtMs;
    if (last != null && last > nowMs) return true; // the clock went back
    return nowMs - first >= kLegacyAutoWindow.inMilliseconds;
  }

  /// The automatic route will not try this session again at [nowMs]: the
  /// budget is spent, the record is unusable, or the window is closed. Only
  /// a person moves it now.
  ///
  /// 🔴 NR-138 round 3 (review B4, MAIN decision): once a stop has been
  /// written ([autoStopped]) this is true at EVERY [nowMs]. Before that the
  /// window was recomputed on every read, and a clock set back to a moment
  /// still later than the last start reopened a recording the phone had
  /// already shown as stopped (the review's day-6 → day-5 probe). The writer
  /// is the legacy leg (`backfill_legacy_leg.dart` `_latchStopped`), the first
  /// time it observes this answer.
  bool stoppedAt(int nowMs) =>
      !readable || autoStopped || budgetExhausted || windowClosedAt(nowMs);

  /// May an automatic start be made at [nowMs]?
  bool mayAutoAttemptAt(int nowMs) {
    if (stoppedAt(nowMs)) return false;
    final int? due = nextEligibleAtMs;
    return due == null || nowMs >= due;
  }

  LegacyRetryRecord _record({
    required int starts,
    required int failedStarts,
    required int? nextEligibleAtMs,
    int? reservedAtMs,
    String? reservedBy,
    int? startedAtMs,
    int? stoppedAtMs,
  }) =>
      LegacyRetryRecord(
        starts: starts,
        failedStarts: failedStarts,
        nextEligibleAtMs: nextEligibleAtMs,
        reservedAtMs: reservedAtMs,
        reservedBy: reservedBy,
        // A start (reserved or resolved) moves the two times; a release
        // ([startedAtMs] null) puts back what was there before it.
        firstAutoStartAtMs: firstAutoStartAtMs ?? startedAtMs,
        lastAutoStartAtMs: startedAtMs ?? lastAutoStartAtMs,
        // One-way: a stop already written is carried by every later record.
        autoStoppedAtMs: autoStoppedAtMs ?? stoppedAtMs,
      );

  /// Written before `audio:start`. Folds a stale reservation into the counts,
  /// so the record on disk never under-states what has already happened.
  LegacyRetryRecord reserve({required int nowMs, required String owner}) =>
      _record(
        starts: starts,
        failedStarts: failedStarts,
        nextEligibleAtMs: nextEligibleAtMs,
        reservedAtMs: nowMs,
        reservedBy: owner,
        startedAtMs: nowMs,
      );

  /// NR-138 round 3 (review B4) — the record that writes the stop down, the
  /// first time [stoppedAt] was observed at [nowMs]. A stale reservation is
  /// folded into the counts (as [reserve] does) and not kept: nothing will be
  /// sent on this session automatically again.
  LegacyRetryRecord stop({required int nowMs}) => _record(
        starts: starts,
        failedStarts: failedStarts,
        nextEligibleAtMs: nextEligibleAtMs,
        stoppedAtMs: nowMs,
      );

  /// Refused before anything was sent: the reservation goes, nothing counts.
  LegacyRetryRecord release() => _record(
        starts: starts,
        failedStarts: failedStarts,
        nextEligibleAtMs: nextEligibleAtMs,
      );

  /// The start reached the relay and concluded: it counts, it sets no wait.
  /// [startedAtMs] is when it was reserved.
  LegacyRetryRecord concluded({required int startedAtMs}) => _record(
        starts: starts + 1,
        failedStarts: failedStarts,
        nextEligibleAtMs: nextEligibleAtMs,
        startedAtMs: startedAtMs,
      );

  /// The start reached the relay and ended without a conclusion.
  LegacyRetryRecord failed({required int nowMs, required int startedAtMs}) =>
      _record(
        starts: starts + 1,
        failedStarts: failedStarts + 1,
        nextEligibleAtMs:
            nowMs + recoveryBackoffFor(failedStarts + 1).inMilliseconds,
        startedAtMs: startedAtMs,
      );

  @override
  String toString() => 'LegacyRetryStatus(readable=$readable '
      'starts=$starts failed=$failedStarts due=$nextEligibleAtMs)';
}
