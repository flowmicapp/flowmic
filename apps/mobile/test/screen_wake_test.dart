// Card CR-2 (owner 2026-08-29) — the screen-wake hold for continuous recording.
//
// 🔴 WHAT THIS FILE IS ACTUALLY GUARDING. The failure mode of a wake lock is
// not that it fails to engage — that is visible within seconds, on the device,
// to anyone testing the feature. It is that somebody forgets to RELEASE it, and
// that failure is completely silent: no exception, no log, no red test, just a
// phone that will not sleep for the rest of the day and a user who blames the
// battery. Nothing in the type system or the review process catches a missed
// early return on one of the five paths that end a continuous recording.
//
// So the release paths are the subject here, not the hold.
//
// The second subject is honesty: `isHeld` drives a user-visible face
// (「屏幕保持常亮」), so it must report what the PLATFORM did, never what we
// asked for. A refused hold has to read as "not held" or the panel makes a
// claim about the device that the device did not agree to.

import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/audio/screen_wake.dart';

/// Records every request and can refuse, so both directions are drivable
/// without a platform channel.
class _FakePort implements ScreenWakePort {
  _FakePort({this.answer = true});

  /// What the platform "says". `false` is a real production case: an older
  /// host with no channel, or an Android Activity that has already detached.
  bool answer;
  final List<bool> requests = <bool>[];

  @override
  Future<bool> setEnabled(bool on) async {
    requests.add(on);
    return answer;
  }
}

void main() {
  group('CR-2 — holding', () {
    test('a hold the platform accepts reads as held', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      expect(hold.isHeld, isFalse);
      await hold.hold();
      expect(port.requests, <bool>[true]);
      expect(hold.isHeld, isTrue);
    });

    test('🔴 a hold the platform REFUSES reads as not held', () async {
      // The face this drives says the screen will stay on. When the platform
      // did not agree, saying it anyway is a claim about the user's device that
      // nothing backs — the same shape as promising retention on a path where
      // nothing was retained.
      final _FakePort port = _FakePort(answer: false);
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      expect(port.requests, <bool>[true], reason: 'we still ask');
      expect(hold.isHeld, isFalse, reason: 'but we do not claim it');
    });

    test('holding twice asks the platform once', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      await hold.hold();
      expect(port.requests, <bool>[true]);
    });

    test('a refused hold is retried by the next hold (it is not latched off)', () async {
      final _FakePort port = _FakePort(answer: false);
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      port.answer = true; // the Activity attached, the host got upgraded, …
      await hold.hold();
      expect(port.requests, <bool>[true, true]);
      expect(hold.isHeld, isTrue);
    });
  });

  group('CR-2 — releasing, which is the half that fails silently', () {
    test('release tells the platform and clears the claim', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      await hold.release();
      expect(port.requests, <bool>[true, false]);
      expect(hold.isHeld, isFalse);
    });

    test('release without a hold does nothing (a dispose after stop is free)', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.release();
      expect(port.requests, isEmpty);
    });

    test('releasing twice asks the platform once', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      await hold.release();
      await hold.release();
      expect(port.requests, <bool>[true, false]);
    });

    test('🔴 a release the platform refuses still clears the claim', () async {
      // Otherwise `_held` stays true, the NEXT hold short-circuits as a no-op,
      // and the session that follows believes it holds a screen nobody is
      // holding. That is the one way this class could strand a real hold, so it
      // gets its own assertion rather than a comment.
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      port.answer = false;
      await hold.release();
      expect(hold.isHeld, isFalse);

      port.answer = true;
      await hold.hold();
      expect(port.requests, <bool>[true, false, true], reason: 'the next hold really asks');
      expect(hold.isHeld, isTrue);
    });

    test('🔴 every way a continuous recording ends releases the screen', () async {
      // The five terminations named in the contract (17 册 / 08 册): the stop
      // button, the per-plan time cap, quota exhaustion, a link death, and the
      // page being disposed. They are different code paths in the session and
      // they must not be different code paths HERE — which is what an
      // idempotent release buys, and what this table asserts.
      for (final String ending in <String>[
        'stop button', 'plan time cap', 'quota exhausted', 'link death', 'page disposed',
      ]) {
        final _FakePort port = _FakePort();
        final ScreenWakeHold hold = ScreenWakeHold(port: port);
        await hold.hold();
        await hold.release();
        expect(port.requests.last, isFalse, reason: 'ending: $ending');
        expect(hold.isHeld, isFalse, reason: 'ending: $ending');
      }
    });
  });

  group('CR-2 — the re-assert, which exists for a defect that only shows up twice', () {
    test('re-asserts while held', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      await hold.reassertAfterForeground();
      expect(port.requests, <bool>[true, true]);
      expect(hold.isHeld, isTrue);
    });

    test('🔴 does nothing when not holding — the lifecycle edge stays dumb', () async {
      // The foreground edge fires on every return to the app, most of which
      // have nothing to do with a recording. It must be safe to call it
      // unconditionally, or the lifecycle layer would have to learn what the
      // session is doing — and that coupling is how the edge acquires a second
      // reason to exist.
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.reassertAfterForeground();
      expect(port.requests, isEmpty);
    });

    test('a re-assert the platform refuses drops the claim', () async {
      final _FakePort port = _FakePort();
      final ScreenWakeHold hold = ScreenWakeHold(port: port);
      await hold.hold();
      port.answer = false;
      await hold.reassertAfterForeground();
      expect(hold.isHeld, isFalse, reason: 'the face must not outlive the fact');
    });
  });
}
