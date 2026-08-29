// Card CR-9 — ONE BEGIN, ONE END, AND EVERY EXIT REALLY LETS GO (§6 C8).
//
// SPEC-REF:
//   apps/mobile/lib/src/ptt/ptt_continuous.dart (the lifecycle under test)
//   apps/mobile/lib/src/audio/continuous_cap_timer.dart (the ceiling)
//   apps/mobile/lib/src/audio/screen_wake.dart (the hold)
//   task unit §6 C1 / C7 / C8
//
// ── WHY EVERY EXIT GETS ITS OWN CASE ────────────────────────────────────────
//
// Three things turn on together and all three fail SILENTLY when they are left
// on: a stale flag makes the NEXT ordinary press inherit a microphone nothing
// stops (§11-c), a stale ceiling ends a later recording with a sentence about a
// limit nobody reached, and a stale wake lock is a battery reading somebody
// notices next week. None of the three raises anything, so counting call sites
// is not enough — each exit is driven.
//
// Real PttSession + real FSM + real AudioCapture + real ScreenWakeHold; only the
// socket, the OS recorder and the screen-wake platform channel are doubles. The
// channel is mocked rather than injected so the production
// `MethodChannelScreenWake` is the code actually exercised.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/continuous_cap_timer.dart';
import 'package:flowmic/src/audio/local_stop_reasons.dart';
import 'package:flowmic/src/audio/screen_wake.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Poll until [ready], or fail loudly at [limit].
///
/// 🔴 A CEILING, NOT A SLEEP. The two read the same in the passing case and
/// differently in every other one: a sleep that is too short reports a defect
/// that is not there, and one that is long enough on this machine is a
/// wall-clock assumption about somebody else's. The ceiling is generous because
/// its job is to end a hang, not to measure anything.
Future<void> _until(
  bool Function() ready, {
  Duration limit = const Duration(seconds: 10),
}) async {
  final DateTime deadline = DateTime.now().add(limit);
  while (!ready()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('condition never held within ${limit.inSeconds}s');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeSocketTransport transport;
  late FakeAudioRecorder recorder;
  late AudioCapture capture;
  late PttSession session;
  late List<String> stopReasons;

  /// Every `setEnabled` the production hold made, in order. `true` = asked to
  /// hold, `false` = asked to let go.
  late List<bool> wake;

  /// What the platform answers. Set false to model a host that refuses the
  /// hold — the case `ScreenWakeHold.isHeld` exists for.
  late bool wakeGranted;

  /// Set by the one case that disposes the session itself.
  ///
  /// 🔴 A CORRECTION IN PLACE: this file first said 「dispose() is idempotent for
  /// the harness tearDown」, and it is NOT — a second call re-disposes a
  /// ValueNotifier and throws. That was an assumption written as a comment and
  /// never checked, which is the shape this repo keeps finding in its own
  /// notes. The test told me.
  late bool disposedByTest;

  setUp(() async {
    DiagLog.instance.clear();
    wake = <bool>[];
    wakeGranted = true;
    disposedByTest = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(MethodChannelScreenWake.channel, (
      MethodCall call,
    ) async {
      if (call.method != 'setEnabled') return null;
      final bool on = (call.arguments as Map<Object?, Object?>)['on'] as bool;
      wake.add(on);
      // A refusal is only ever a refusal to HOLD; letting go always succeeds.
      return on ? wakeGranted : true;
    });

    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    capture = AudioCapture(recorder: recorder);
    session = newTestSession(transport: transport, audio: capture);
    stopReasons = <String>[];
    session.autoStopped.listen(stopReasons.add);
    transport.pushStatus(SocketStatus.connected);
  });

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(MethodChannelScreenWake.channel, null);
    if (!disposedByTest) await session.dispose();
    await transport.close();
  });

  /// The wake hold is asked for with `unawaited`, so its platform round trip
  /// lands a turn later. Everything here runs on real time.
  Future<void> settle() => Future<void>.delayed(Duration.zero);

  Future<void> startContinuous({
    Duration cap = const Duration(minutes: 30),
    void Function()? onWarning,
  }) async {
    session.beginContinuous(cap: cap, onWarning: onWarning ?? () {});
    expect(await session.pttDown(), isTrue,
        reason: 'positive control: the production chain entered RECORDING');
    await settle();
  }

  test('🔴 begin turns on all three, and they are three different things', () async {
    await startContinuous();

    expect(session.continuous.isActive, isTrue, reason: 'CR-3s flag');
    expect(session.capTimer.isArmed, isTrue, reason: 'CR-6s ceiling');
    expect(session.capTimer.armedCap, const Duration(minutes: 30));
    expect(session.screenWake.isHeld, isTrue, reason: 'CR-2s hold');
    expect(wake, <bool>[true]);
  });

  test('🔴 a host that REFUSES the hold does not stop the recording', () async {
    // The screen is a nice-to-have; the recording is the product. And `isHeld`
    // must then read false, because that is what the in-progress face checks
    // before drawing 「screen stays on」 — a sentence that would otherwise be a
    // lie on exactly the hosts that refused.
    wakeGranted = false;
    await startContinuous();

    expect(session.continuous.isActive, isTrue);
    expect(session.capTimer.isArmed, isTrue);
    expect(session.screenWake.isHeld, isFalse);
    expect(wake, <bool>[true], reason: 'it did ask');
  });

  test('🔴 the user stopping releases all three (C8, exit 1)', () async {
    await startContinuous();
    await session.pttUp();
    await settle();

    expect(session.continuous.isActive, isFalse);
    expect(session.capTimer.isArmed, isFalse);
    expect(session.capTimer.armedCap, isNull);
    expect(session.screenWake.isHeld, isFalse);
    expect(wake, <bool>[true, false]);
    expect(stopReasons, isEmpty,
        reason: 'the user did it — nothing to announce');
  });

  test('🔴 the recorder dying releases all three (C8, exit 3)', () async {
    // Driven through the REAL fault path rather than by poking a controller:
    // the recorder opens, feeds nothing, and `AudioCapture` decides on its own
    // that a microphone which produced zero bytes is dead. Costs 1.5 s of wall
    // clock, and buys a case that exercises the production edge.
    await startContinuous();
    // ⚠️ WAITED FOR, NOT SLEPT THROUGH. The first cut was a fixed
    // `kDeadCaptureAfter + 250ms`, which passed alone and FLAKED inside the
    // full parallel suite — a 250 ms margin is not a margin on a loaded
    // machine. A test whose verdict depends on how busy the box is reports the
    // box, not the code.
    await _until(() => !session.capTimer.isArmed);

    expect(session.capTimer.isArmed, isFalse,
        reason: 'otherwise the ceiling fires later and announces a limit '
            'nobody reached, for a capture that is already gone');
    expect(session.screenWake.isHeld, isFalse);
    expect(session.continuous.isActive, isFalse);
  });

  test('🔴 disposing releases all three (C8, exit 5)', () async {
    await startContinuous();
    disposedByTest = true;
    await session.dispose();
    await settle();

    expect(session.capTimer.isArmed, isFalse);
    expect(session.screenWake.isHeld, isFalse);
    expect(wake.last, isFalse);
  });

  test('end is idempotent and safe on a capture that was never continuous',
      () async {
    // The reason `pttUp` can call it unconditionally instead of behind a 「was
    // it continuous」 test that would be a second author for the same fact.
    expect(await session.pttDown(), isTrue);
    await session.pttUp();
    await settle();
    expect(wake, isEmpty, reason: 'an ordinary press never asked for the screen');

    session.endContinuous();
    session.endContinuous();
    expect(session.capTimer.isArmed, isFalse);
    expect(session.screenWake.isHeld, isFalse);
  });

  group('🔴 the ceiling', () {
    test('ends the recording through the ORDINARY release, and says so in its '
        'own words', () async {
      // A short cap so the real timer fires inside the test. Shorter than the
      // warning lead, so no reminder is scheduled — which is itself the
      // documented behaviour (「a sitting shorter than the lead gets NO
      // reminder rather than one at t=0」).
      await startContinuous(cap: const Duration(milliseconds: 60));
      await _until(() => stopReasons.isNotEmpty);
      await settle();

      // The ORDINARY release: `audio:stop` went out, so the server finalises
      // the last segment. A fence would have meant 「this never happened」 and
      // thrown that segment away — with copy on screen claiming it was saved.
      expect(transport.emittedWhere('audio:stop'), hasLength(1));
      expect(stopReasons, <String>[kLocalStopReasonContinuousCap],
          reason: 'its own reason, never hard_limit and never quota_exhausted '
              '— W8-4: pressing again works after this one and does not after '
              'those');
      expect(session.continuous.isActive, isFalse);
      expect(session.screenWake.isHeld, isFalse);
    });

    test('🔴 refuses to announce a ceiling nobody reached', () async {
      // By the time a timer fires the user may have stopped already. Reporting
      // the limit then would be a fabricated state, and this is the one place
      // it could be invented.
      await startContinuous();
      await session.pttUp();
      await settle();
      stopReasons.clear();

      await session.stopForContinuousCap();
      await settle();

      expect(stopReasons, isEmpty);
      final List<String> log = DiagLog.instance.snapshot();
      expect(log.where((String l) => l.contains('cap_stale')), hasLength(1),
          reason: 'and it says so in the trail rather than silently doing '
              'nothing');
    });

    test('the one-minute reminder raises a ticket exactly once, and a stop '
        'clears it', () async {
      int warnings = 0;
      await startContinuous(
        cap: kContinuousCapWarningLead + const Duration(milliseconds: 60),
        onWarning: () => warnings++,
      );
      expect(session.capTimer.warningTicket, 0, reason: 'not yet');

      // The warn timer is scheduled at cap - lead = 60 ms.
      await _until(() => warnings > 0);
      expect(warnings, 1);
      expect(session.capTimer.warningTicket, isNot(0));

      await session.pttUp();
      await settle();
      expect(session.capTimer.warningTicket, 0,
          reason: 'the reminder says 「one minute left of a recording」; once '
              'there is no recording it has nothing to be about');
    });
  });
}
