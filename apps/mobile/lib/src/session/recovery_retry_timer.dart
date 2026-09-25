// Card RC-O — THE AUTOMATIC RETRY HAPPENS WHEN IT IS DUE, NOT AT THE NEXT EDGE.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.1 / §8 RC-O
//   apps/mobile/lib/src/session/recovery_backoff.dart (`nextEligibleAtMs`, the
//     only writer being `recovery_leg_settle.dart` `_finish`)
//   apps/mobile/lib/src/session/backfill_runner.dart (the one owner)
//
// A failed automatic attempt writes `nextEligibleAtMs` (1, 2, 4… minutes out)
// and the sweep reads it — but a sweep only ran on three edges: the link coming
// up, a recording ending, an owed tail's ticket. MEASURED (S6): the rule was
// lifted, the link stayed up, and for 7.5 minutes nothing asked; the page kept
// saying 「断网时录下的 1:05 还在转写」. A backoff nobody wakes up for is a
// deadline that never arrives.
//
// ⇒ after every pass the runner asks for the earliest due time of the
// recordings still owed an automatic attempt, and arms ONE timer for it. The
// three edges are untouched; this is a fourth, and it only fires into an idle
// session on a live link — anything else is one of the edges' business.

import 'dart:async';

import '../audio/retained_audio_journal_scan.dart';
import '../audio/retained_audio_spill.dart';
import 'recovery_backoff.dart';

class RecoveryRetryTimer {
  RecoveryRetryTimer({
    required void Function() onDue,
    int Function()? clock,
    Timer Function(Duration, void Function())? timer,
  })  : _onDue = onDue,
        _clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch),
        _timer = timer ?? Timer.new;

  final void Function() _onDue;
  final int Function() _clock;
  final Timer Function(Duration, void Function()) _timer;
  Timer? _armed;

  /// The earliest future `nextEligibleAtMs` among recordings an automatic
  /// attempt may still be made for, or null when none is waiting on a clock.
  ///
  /// The same exclusions the journal leg's candidate scan makes, as far as
  /// they decide 「will an automatic attempt ever run」: unreadable, cancelled
  /// (O-5), format-mismatched and settled recordings never get one, and
  /// [RecoveryJobStatus.mayAutoAttemptAt] answers the rest (terminal settles,
  /// `needs_manual`, `shortfall`, a spent budget).
  static Future<int?> earliestDueMs(RetainedAudioSpill spill, int nowMs) async {
    int? due;
    for (final RecordingScan s in await RetainedAudioJournalScan.scan(
      dirPath: spill.store.dirPath,
      fs: spill.journalFs,
      deleted: spill.deletedRecordings,
    )) {
      final m = s.manifest;
      if (m == null || s.quarantined || s.manifestMissing) continue;
      if (s.formatMismatch || s.cancelled || m.settled) continue;
      final RecoveryJobStatus st = RecoveryJobStatus.fromManifest(m);
      final int? at = st.nextEligibleAtMs;
      if (at == null || at <= nowMs || !st.mayAutoAttemptAt(at)) continue;
      if (due == null || at < due) due = at;
    }
    return due;
  }

  /// Arm for [dueAtMs] (replacing any armed one); null disarms.
  void arm(int? dueAtMs) {
    cancel();
    if (dueAtMs == null) return;
    final int wait = dueAtMs - _clock();
    _armed = _timer(Duration(milliseconds: wait < 0 ? 0 : wait), () {
      _armed = null;
      _onDue();
    });
  }

  bool get isArmed => _armed != null;

  void cancel() {
    _armed?.cancel();
    _armed = null;
  }
}
