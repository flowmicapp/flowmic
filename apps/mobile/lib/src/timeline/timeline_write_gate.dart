// NR-137 round 10b/10c — THE WRITE GATE BETWEEN A RELEASE'S PROOF AND ITS SEAL.
//
// Round 10 took one fresh proof immediately before the commit that arms a
// release, and left a window: any writer could add, restore or un-resolve a
// relevant row between that proof and the moment the audio's fate was sealed
// (a cloud merge saving a retry, a sync or an import landing a row, the
// session writing one). A proof is only as good as the instant it stands for.
//
// WHY A NEW GATE. No existing serialisation spans the writers: SQLite queues
// its own writes (`SqfliteTimelinePersistence._serialize`), the fallback and
// the cloud retry store write SharedPreferences with no queue at all, and the
// one-time import writes the database directly.
//
// WHY ONE PER PROCESS. A process has one timeline. A gate anchored on a store
// object would let any wrapper around that store hold a different gate from
// the store it wraps — two answers to "is anyone writing?".
//
// 🔴 ROUND 10c — BOUNDED, AND WRITERS NEVER WAIT ON A PROOF. Round 10b held the
// gate from before the final proof to after the PCM delete, with no limit: a
// proof that hung stopped every timeline write, new dictation included — a
// remote latch with no local watchdog. Measured (desktop, `flutter_test`, the
// shipped backends; `_dispatch/nr137-r10c-proof-timing.log`): the proof grows
// with the timeline — SQLite 6.9 ms at 100 rows, 110 ms at 5,000, 436 ms at
// 20,000; the SharedPreferences fallback 118 ms at 1,000, 611 ms at 5,000. A
// phone is several times slower, so a proof under the gate would block
// dictation for seconds. So:
//   · WRITERS ([run]) never wait for each other, and never wait on a proof.
//     They wait only while a release SEALS, at most [kHoldBudget].
//   · A RELEASE ([release]) proves with writers running, at most
//     [kProofBudget] in all. If any writer ran during its proof, the proof may
//     be stale: it yields and proves again ([kProofTries] in all). Only when a
//     proof saw no writer does it take the HOLD — checking and taking it with
//     no await between — and run its SEAL inside: the one write that decides
//     the audio's fate (the settled manifest commit; for a legacy session,
//     the segment deletes). The seal gets [kHoldBudget]; measured on this
//     disk, a manifest commit (PCM flush, temp write with flush, rename) is
//     6.8 ms median and 15.8 ms worst, a 12.75 MB PCM delete about 1 ms
//     (`_dispatch/nr137-r10c-seal-timing.log`).
//   · Anything else — a proof past its budget, a seal past its budget, a proof
//     or seal that threw, writers busy through every try — is a verdict the
//     caller turns into "audio kept, press failed". The hold always ends.
// Every abort writes one diagnostic line (`timeline.release_aborted`):
// phase, reason, milliseconds, tries — no ids, no text.
//
// WHO TAKES IT:
//   · every persistence write — SQLite (`_serialize`), the SharedPrefs
//     fallback, the in-memory double (upsert, delete, saveAll, batch);
//   · the cloud retry store (`saveRetry`, `removeRetry`);
//   · the one-time import (`_importOnce`), which writes the database directly;
//   · a release (`recovery_leg_rows.dart` `_sealRelease`,
//     `backfill_legacy_kept.dart`).
// A seal never calls a gated write: it is a journal commit or file deletes.

import 'dart:async';

import '../diag/diag_log.dart';

/// What a [TimelineWriteGate.release] came to.
enum TimelineReleaseVerdict {
  /// Proven with no writer running, and sealed inside the hold.
  released,

  /// The proof said no, or the seal reported that it did not land.
  notProven,

  /// The proof outlived [TimelineWriteGate.kProofBudget], or the seal
  /// [TimelineWriteGate.kHoldBudget].
  timedOut,

  /// The proof or the seal threw.
  threw,

  /// Writers ran during every one of [TimelineWriteGate.kProofTries] proofs.
  yielded,
}

class TimelineWriteGate {
  TimelineWriteGate._();

  /// The gate of this process's timeline.
  static final TimelineWriteGate timeline = TimelineWriteGate._();

  /// The longest a seal may hold writers off.
  static const Duration kHoldBudget = Duration(milliseconds: 500);

  /// The longest a release may spend proving, all tries together. The gate is
  /// not held while it proves; this bounds how long a hung proof keeps a
  /// press waiting (its audio kept, the press failed).
  static const Duration kProofBudget = Duration(seconds: 10);

  /// Proofs a release takes before it gives way to busy writers.
  static const int kProofTries = 3;

  int _running = 0;
  int _epoch = 0;
  bool _held = false;
  final List<Completer<void>> _waiting = <Completer<void>>[];

  /// A turn to wait out a seal in progress. ⚠️ Each waiter waits on a
  /// completer made in ITS OWN zone: a stored future shared by every caller
  /// resumed them in the zone that made it, and under `flutter_test`'s fake
  /// async a finished test's zone never runs again (measured in round 10b: 12
  /// tests in 5 files hung after their file's first test).
  /// ⚠️ Callers loop on `while (_held) await _turn();` INLINE: a helper that
  /// awaited would resume them a microtask later, after a release could have
  /// taken the hold, and they would then run inside its seal.
  Future<void> _turn() {
    final Completer<void> turn = Completer<void>();
    _waiting.add(turn);
    return turn.future;
  }

  /// Run the write [body]. It waits only while a release seals.
  Future<T> run<T>(Future<T> Function() body) async {
    while (_held) {
      await _turn();
    }
    _running++;
    _epoch++;
    try {
      return await body();
    } finally {
      _running--;
      _epoch++;
    }
  }

  /// [prove] what a release stands on, then [seal] it inside the hold. Only
  /// [TimelineReleaseVerdict.released] lets the audio go.
  Future<TimelineReleaseVerdict> release({
    required Future<bool> Function() prove,
    required Future<bool> Function() seal,
  }) async {
    final Stopwatch spent = Stopwatch()..start();
    for (int tries = 1;; tries++) {
      final int epoch = _epoch;
      final bool quiet = _running == 0;
      final bool proven;
      try {
        final Duration left = kProofBudget - spent.elapsed;
        proven = await prove().timeout(left.isNegative ? Duration.zero : left);
      } on TimeoutException {
        return _aborted('proof', 'timeout', spent, tries,
            TimelineReleaseVerdict.timedOut);
      } on Object {
        return _aborted(
            'proof', 'threw', spent, tries, TimelineReleaseVerdict.threw);
      }
      if (!proven) return TimelineReleaseVerdict.notProven;
      while (_held) {
        await _turn();
      }
      // No await from here to `_held = true`: nothing can start in between.
      if (!quiet || _running > 0 || _epoch != epoch) {
        if (tries < kProofTries && spent.elapsed < kProofBudget) continue;
        return _aborted(
            'proof', 'busy', spent, tries, TimelineReleaseVerdict.yielded);
      }
      _held = true;
      final Stopwatch held = Stopwatch()..start();
      try {
        return await seal().timeout(kHoldBudget)
            ? TimelineReleaseVerdict.released
            : TimelineReleaseVerdict.notProven;
      } on TimeoutException {
        return _aborted(
            'seal', 'timeout', held, tries, TimelineReleaseVerdict.timedOut);
      } on Object {
        return _aborted(
            'seal', 'threw', held, tries, TimelineReleaseVerdict.threw);
      } finally {
        _held = false;
        final List<Completer<void>> go = List<Completer<void>>.of(_waiting);
        _waiting.clear();
        for (final Completer<void> turn in go) {
          turn.complete();
        }
      }
    }
  }

  TimelineReleaseVerdict _aborted(String phase, String reason, Stopwatch took,
      int tries, TimelineReleaseVerdict verdict) {
    diag('timeline.release_aborted', <String, Object?>{
      'phase': phase,
      'reason': reason,
      'ms': took.elapsedMilliseconds,
      'tries': tries,
    });
    return verdict;
  }
}
