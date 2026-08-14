// F8② — a FAILED connect must leave NOTHING dialling.
//
// SPEC-REF:
//   lib/src/session/connections_controller.dart (leaveRoom / connectTo / enterCloud)
//   lib/src/signaling/reconnect.dart (_onStatus → _scheduleReconnect)
//   lib/src/session/hold_out_retry.dart (the 「when to ask again」 timer)
//   lib/src/ui/connections_page.dart `_connect()` (the failure arm: a toast, nothing else)
//
// ── WHAT WENT WRONG ──────────────────────────────────────────────────────────
// `resumePairing` starts the reconnect ladder BEFORE the `mobile:reconnect` ack
// is awaited (`reconnect.start()` sits immediately above `_emitMobileReconnect`
// in ptt_session.dart), so by the time a refusal comes back the ladder is
// already live. `connectTo`'s failure arm then called ONLY
// `transport.disconnect()` — and `disconnected` is precisely the ladder's cue to
// climb (reconnect.dart `_onStatus`, backoff 1→2→4→…→30 s). `leaveRoom()` two
// screens away had this right all along and says why in its own doc comment.
//
// The consequence is not cosmetic. The user is on the instance list looking at
// 「电脑正忙…」 and there is nothing on that screen that would ever tell them
// otherwise: `connections_page._connect` navigates on the `ConnectOutcome` it
// awaited and nobody listens for `session.paired` flipping back to true. So the
// rejoin is invisible on the phone and fully visible on the PC — it takes the
// room back (blocking a second phone), and the capsule surfaces for someone who
// gave up and walked away minutes ago.
//
// ── WHAT IS ASSERTED, AND WHY THAT ───────────────────────────────────────────
// The observable is the DIAL and the re-join FRAME, not an internal `isRunning`
// flag: a coordinator that is "running" and never dials harms nobody, and one
// that is stopped while a timer is still in flight harms the user anyway. The
// two counters are proven non-blind by the positive control at the bottom,
// which is this same harness minus the failure — required by CLAUDE.md 「负向
// 断言必须自带正向对照」, and it doubles as the guard against the lazy over-fix
// (never starting the ladder at all, which would break every real outage).
//
// Real clock, not `fakeAsync`, for the reason hold_out_recheck_wire_test.dart
// gives at its head: taming `resumePairing`'s probe + 5 s ack timeout + the
// microtasks would replace the question 「did we connect」 with 「did I set my fake clock right」.
// The budget is 1 ms so `HoldOutRetry.minWait` clamps it to 1 s, level with the
// ladder's `initialBackoff`; one wait therefore covers both timers.

import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/pc_presence_probe.dart' show PcPresenceReading;
import 'package:flowmic/src/signaling/socket_core.dart' show EventEnvelope;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Comfortably past BOTH the ladder's first rung (`initialBackoff` = 1 s) and
/// the clamped hold-out budget (`HoldOutRetry.minWait` = 1 s).
///
/// ⚠️ Deliberately generous rather than 「1 s + ε」. A negative assertion on a
/// real clock fails SILENTLY UPWARD: on a loaded machine a wait that is merely
/// long enough on paper turns the test green because the timer had not fired
/// yet, not because nothing was scheduled. The positive control below therefore
/// polls instead of waiting a fixed span — it must never be the thing that goes
/// flaky, since it is the only proof these counters can move at all.
const Duration _pastBothTimers = Duration(milliseconds: 2500);

/// Wait until [seen] reports progress, or give up after [limit]. Returns the
/// outcome so the caller asserts it (never a bare `return` that reads green).
Future<bool> _waitFor(bool Function() seen,
    {Duration limit = const Duration(seconds: 8)}) async {
  final DateTime deadline = DateTime.now().add(limit);
  while (DateTime.now().isBefore(deadline)) {
    if (seen()) return true;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  return seen();
}

int _reconnectFrames(FakeSocketTransport t) =>
    t.emitted.where((EventEnvelope e) => e.name == 'mobile:reconnect').length;

const MobileSession _pairing = MobileSession(
  token: 'tok-f8-000000000000000000000000',
  endpoint: 'http://192.0.2.5:55889',
  channel: 'standalone',
  pcName: 'Studio PC',
  pairingId: 'pair-f8',
);

void main() {
  late FakeSocketTransport t;
  late PttSession session;
  late LoginController login;
  late ConnectionsController ctl;

  setUp(() {
    t = FakeSocketTransport()..connectSucceeds = true;
    session = newTestSession(transport: t)
      // Endpoint selection must never touch the network here; these tests are
      // about what happens AFTER the refusal, not about which NIC we picked.
      ..healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
    login = newTestLogin(transport: t, saasEndpoint: 'https://saas.test:443');
    ctl = ConnectionsController(
      session: session,
      login: login,
      saasEndpoint: 'https://saas.test:443',
      healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
      presenceReader: (Uri url, String token, Duration timeout) async =>
          PcPresenceReading.unknown,
    );
  });

  tearDown(() async {
    ctl.dispose();
    login.dispose();
    await session.dispose();
  });

  // Both hold-out codes, because they take different branches on the way in:
  // `PC_BUSY` also raises the occupancy banner, `PAIR_RELEASED` deliberately
  // does not (hold_out_retry.dart file header). Neither may leave anything dialling.
  for (final String code in <String>['PAIR_RELEASED', 'PC_BUSY']) {
    test('$code: a refused connect leaves nothing dialling', () async {
      await session.tokenStorage.addOrUpdatePairing(_pairing);
      await ctl.load();
      // Byte shape of the real refusal (mobile.handler.ts:229-233): retryable,
      // token deliberately kept, budget attached.
      t.defaultAck = <String, Object?>{
        'error': code,
        'retryable': true,
        'retry_after_ms': 1,
      };

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
      expect(out.success, isFalse,
          reason: 'the attempt must really have failed, or this tests nothing');

      final int dialsAtFailure = t.connectCalls;
      final int framesAtFailure = _reconnectFrames(t);
      expect(dialsAtFailure, 1, reason: 'one dial: the one the user asked for');
      expect(framesAtFailure, 1, reason: 'one ask: the one that was refused');

      await Future<void>.delayed(_pastBothTimers);

      // The re-join FRAME first: it is the harm itself (the PC hands the room
      // back to a phone whose owner walked away). The re-dial is its cause.
      expect(_reconnectFrames(t), framesAtFailure,
          reason: 'the phone asked to re-join the room after the user gave up');
      expect(t.connectCalls, dialsAtFailure,
          reason: 'the ladder re-dialled a PC the user was just told we could '
              'not enter — and nothing on screen would ever say so');
      // Secondary, cheap, and the two things a maintainer will look at first.
      expect(session.reconnect.isRunning, isFalse, reason: 'ladder still armed');
      expect(session.holdOutArmed, isFalse, reason: 'hold-out timer still armed');
    });
  }

  test('POSITIVE CONTROL — after a SUCCESSFUL connect the ladder still climbs',
      () async {
    await session.tokenStorage.addOrUpdatePairing(_pairing);
    await ctl.load();
    // `FakeSocketTransport.defaultAck` is already the server's success shape.

    final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
    expect(out.success, isTrue);
    final int dials = t.connectCalls;
    final int frames = _reconnectFrames(t);

    // A real outage — the case the ladder exists for.
    await t.disconnect();
    final bool climbed = await _waitFor(() =>
        t.connectCalls > dials && _reconnectFrames(t) > frames);

    expect(climbed, isTrue,
        reason: 'the probe is blind: this harness cannot observe a re-dial or a '
            're-join at all, so every negative assertion above proves nothing');
  });

  // The invariant belongs to the FAILURE ARM, not to whichever caller happened
  // to arm the ladder. ⚠️ Stated honestly: today no production path reaches
  // `enterCloud` with a live ladder — `PttSession.pair()` calls
  // `reconnect.start()` only AFTER a successful ack, and `connections_page`
  // calls `leaveRoom()` on the way back from chat. So this arms the coordinator
  // through its own public API (exactly what `resumePairing` does) and pins that
  // a refused cloud admission tears down what it found, rather than handing the
  // question 「who is responsible for stopping」 to the caller. It is a symmetry test, not a reproduced
  // field defect; do not read it as evidence that the cloud path was observed
  // rejoining.
  test('a refused cloud admission stops a ladder that was already running',
      () async {
    t.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'jwt-abc',
      'user': <String, Object?>{'id': 'u1', 'email': 'f@example.com', 'plan': 'free'},
      'mode': 'saas',
    });
    await login.login(email: 'f@example.com', password: 'secret12');

    session.reconnect.configure(
      url: 'http://192.0.2.5:55889',
      token: _pairing.token,
      replaceToken: true,
    );
    session.reconnect.start();
    expect(session.reconnect.isRunning, isTrue, reason: 'nothing to tear down');

    t.defaultAck = <String, Object?>{'error': 'CLOUD_INSTANCE_UNAVAILABLE'};
    final ConnectOutcome out = await ctl.enterCloud();
    expect(out.success, isFalse);

    final int dials = t.connectCalls;
    await Future<void>.delayed(_pastBothTimers);
    expect(t.connectCalls, dials,
        reason: 'the ladder kept dialling the LAN PC after a failed cloud entry');
    expect(session.reconnect.isRunning, isFalse);
  });
}
