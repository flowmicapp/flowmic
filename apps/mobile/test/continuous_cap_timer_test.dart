// Card CR-6 — the per-session ceiling's clock.
//
// SPEC-REF: apps/mobile/lib/src/audio/continuous_cap_timer.dart
//
// 🔴 THE DISARM PATHS ARE THE SUBJECT, same as the screen-wake hold. A ceiling
// that fails to fire ends nothing and the user notices within a minute. A
// ceiling that SURVIVES its recording ends a LATER one at an arbitrary moment,
// silently, with nothing on screen that could explain it — and the later one
// may be an ordinary push-to-talk press that has no ceiling at all.
//
// Driven through the injected timer factory rather than fakeAsync so each
// assertion names the duration it is about; the durations here are the product
// decision, and a test that only proved "something fired eventually" would not
// notice the warning drifting to the wrong minute.

import 'dart:async';

import 'package:flowmic/src/audio/continuous_cap_timer.dart';
import 'package:flutter_test/flutter_test.dart';

const Duration _thirty = Duration(minutes: 30);
const Duration _ten = Duration(minutes: 10);

/// A timer factory that records what was scheduled and lets a test fire it.
class _Scheduler {
  final List<Duration> scheduled = <Duration>[];
  final List<void Function()> fires = <void Function()>[];
  final List<bool> cancelled = <bool>[];

  Timer make(Duration d, void Function() fire) {
    final int i = scheduled.length;
    scheduled.add(d);
    fires.add(fire);
    cancelled.add(false);
    return _FakeTimer(() => cancelled[i] = true);
  }

  void fire(int i) => fires[i]();
}

class _FakeTimer implements Timer {
  _FakeTimer(this._onCancel);
  final void Function() _onCancel;
  bool _active = true;

  @override
  void cancel() {
    _active = false;
    _onCancel();
  }

  @override
  bool get isActive => _active;

  @override
  int get tick => 0;
}

void main() {
  late _Scheduler sched;
  late ContinuousCapTimer timer;
  late int warnings;
  late int caps;

  setUp(() {
    sched = _Scheduler();
    timer = ContinuousCapTimer(timerFactory: sched.make);
    warnings = 0;
    caps = 0;
  });

  void armFor(Duration cap) => timer.arm(
        cap: cap,
        onWarning: () => warnings++,
        onCap: () => caps++,
      );

  group('the two moments', () {
    test('🔴 warns one minute before the ceiling, not at some other minute',
        () {
      armFor(_thirty);
      expect(sched.scheduled,
          <Duration>[const Duration(minutes: 29), _thirty]);
    });

    test('the free tier gets the same lead, not a scaled one', () {
      armFor(_ten);
      expect(sched.scheduled, <Duration>[const Duration(minutes: 9), _ten]);
    });

    test('firing them calls the right callback each time', () {
      armFor(_thirty);
      sched.fire(0);
      expect(<int>[warnings, caps], <int>[1, 0]);
      sched.fire(1);
      expect(<int>[warnings, caps], <int>[1, 1]);
    });

    test('🔴 a sitting shorter than the lead gets NO reminder, not one at t=0',
        () {
      // "One minute left" delivered the instant recording starts is true and
      // useless, and it spends the single interruption this feature is allowed.
      const Duration half = Duration(seconds: 30);
      armFor(half);
      expect(sched.scheduled, <Duration>[half]);
      sched.fire(0);
      expect(<int>[warnings, caps], <int>[0, 1]);
    });

    test('a cap exactly equal to the lead also gets no reminder', () {
      armFor(kContinuousCapWarningLead);
      expect(sched.scheduled, <Duration>[kContinuousCapWarningLead]);
    });
  });

  group('🔴 disarming, which is the half that fails silently', () {
    test('disarm cancels both timers', () {
      armFor(_thirty);
      timer.disarm();
      expect(sched.cancelled, <bool>[true, true]);
      expect(timer.isArmed, isFalse);
    });

    test('disarm without arming is free (a dispose after stop costs nothing)',
        () {
      timer.disarm();
      expect(sched.scheduled, isEmpty);
    });

    test('disarming twice is free', () {
      armFor(_thirty);
      timer.disarm();
      timer.disarm();
      expect(sched.cancelled, <bool>[true, true]);
    });

    test('🔴 every ending disarms — and they are the same code path', () {
      // Stop button, tier ceiling, quota exhaustion, link death, page disposed.
      // They are different paths in the session and must not be different paths
      // here, which is what an idempotent disarm buys.
      for (final String ending in <String>[
        'stop button',
        'tier cap',
        'quota exhausted',
        'link death',
        'disposed',
      ]) {
        final _Scheduler s = _Scheduler();
        final ContinuousCapTimer t = ContinuousCapTimer(timerFactory: s.make);
        t.arm(cap: _thirty, onWarning: () {}, onCap: () {});
        t.disarm();
        expect(s.cancelled, <bool>[true, true], reason: 'ending: $ending');
        expect(t.isArmed, isFalse, reason: 'ending: $ending');
      }
    });

    test('🔴 a ceiling cannot survive into the NEXT recording', () {
      // The failure this class exists to prevent: an ordinary press, minutes
      // later, ended by a ceiling belonging to a recording that is over.
      armFor(_ten);
      timer.disarm();
      expect(timer.isArmed, isFalse);
      expect(sched.cancelled.every((bool c) => c), isTrue);
    });

    test('re-arming replaces rather than stacking a second ceiling', () {
      armFor(_thirty);
      armFor(_ten);
      expect(sched.cancelled.take(2), <bool>[true, true]);
      expect(sched.scheduled, <Duration>[
        const Duration(minutes: 29),
        _thirty,
        const Duration(minutes: 9),
        _ten,
      ]);
    });
  });

  group('🔴 a ceiling we could not believe arms nothing', () {
    // `CloudSummary.continuousMinutes` is null when the read failed, and its
    // doc says a recording may not start without it. This class refuses to
    // invent a fallback: a default ceiling would be a number nobody chose,
    // enforced silently, on somebody's meeting.
    for (final Duration bad in const <Duration>[
      Duration.zero,
      Duration(minutes: -5),
    ]) {
      test('cap of $bad schedules nothing and is not an error', () {
        armFor(bad);
        expect(sched.scheduled, isEmpty);
        expect(timer.isArmed, isFalse);
      });
    }
  });

  test('the ceiling clears its own state before calling back', () {
    // The caller's onCap handler ends the recording, which calls disarm().
    // If `_cap` were still set at that moment we would be relying on Timer
    // re-entrancy rather than on this object's own state being true.
    bool armedDuringCallback = true;
    timer.arm(
      cap: _thirty,
      onWarning: () {},
      onCap: () => armedDuringCallback = timer.isArmed,
    );
    sched.fire(1);
    expect(armedDuringCallback, isFalse);
  });
}
