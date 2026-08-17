// G-15① — wiring test for periodically asking "is the PC still there"
// (`GET /api/pc/presence`) while the session is idle.
//
// SPEC-REF: docs/decisions/2026-08-01-idle-pc-presence-poll-interval.md
//           (owner ruling: every 10 seconds + five implementation constraints);
//           docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.4①/§6 G-15;
//           lib/src/ptt/ptt_presence_poll.dart (implementation under test; the
//           file header maps one-to-one onto the five constraints).
//
// 🔴 This file exists for "wiring", not "is this function correct" —
// `httpPcPresenceRead`'s own shape (404/401/field is not bool/`ws://` throws
// `ArgumentError` all land unknown) is already pinned with a real `HttpServer`
// in pc_presence_probe_test.dart; this file does not repeat that. What it pins
// is: **the production path really does call it periodically**, only when it
// should, and the answer really lands on the single writer.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

const String _kToken = 'tok-test-abcdefghijklmnopqrstuvwxyz012';
const String _kEndpoint = 'http://127.0.0.1:9999';
const String _kPcId = 'pc-test-1';

/// Records every call [PttSession.presenceReader] receives; answers from a
/// FIFO queue (default: `online`/[_kPcId]), or throws a queued error first.
class _FakeReader {
  final List<Uri> urls = <Uri>[];
  final List<String> tokens = <String>[];

  /// The per-attempt budget each call was handed. Recorded because a knob whose
  /// value never reaches the thing it is supposed to govern is not a knob — see
  /// the liveness test at the bottom of this file.
  final List<Duration> timeouts = <Duration>[];
  final List<Object> _throwQueue = <Object>[];
  final List<PcPresenceReading> _answerQueue = <PcPresenceReading>[];
  int get calls => urls.length;

  void answerOnceWith(PcPresenceReading r) => _answerQueue.add(r);
  void throwOnceWith(Object e) => _throwQueue.add(e);

  Future<PcPresenceReading> call(Uri url, String token, Duration timeout) async {
    urls.add(url);
    tokens.add(token);
    timeouts.add(timeout);
    if (_throwQueue.isNotEmpty) throw _throwQueue.removeAt(0);
    if (_answerQueue.isNotEmpty) return _answerQueue.removeAt(0);
    return const PcPresenceReading(presence: PcPresence.online, pcId: _kPcId);
  }
}

class _Built {
  _Built(this.session, this.transport, this.reader, this.recorder);
  final PttSession session;
  final FakeSocketTransport transport;
  final _FakeReader reader;
  final FakeAudioRecorder recorder;
}

/// Drives a REAL [PttSession.resumePairing] to completion (not
/// [PttSession.applyPairedIdentity] poked directly) so the session ends up
/// CONNECTED + IDLE the same way production gets there — which matters here
/// specifically because [_startPresencePoll] (ptt_presence_poll.dart) is now
/// wired off THAT call's `onAccepted`, not off the raw `connected` socket
/// edge (see that file's doc for why the raw edge was wrong: it fired for
/// every widget-test fixture that merely faked a connection without ever
/// pairing, leaking a real `Timer` past the test body into
/// `flutter_test`'s pending-timer check).
///
/// Must run INSIDE the [FakeAsync] zone (hence taking [async] rather than
/// being `async` itself): everything `resumePairing` awaits here resolves via
/// microtasks only (`FakeSocketTransport.connect`/`emitWithAck` never touch a
/// real Timer), so `async.flushMicrotasks()` drains it synchronously and the
/// `Timer.periodic` this test then measures is created INSIDE the fake zone,
/// where `async.elapse` actually controls it.
_Built _pair(FakeAsync async, {String channel = 'standalone'}) {
  final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
  final FakeAudioRecorder rec = FakeAudioRecorder();
  final PttSession session = PttSession(
    transport: t,
    stateMachine: FlowmicStateMachine(),
    audio: AudioCapture(recorder: rec),
    tokenStorage: InMemoryTokenStorage(),
    // Card U2: this fixture drives pttDown to prove the poll pauses while
    // recording, so it has to name a granted mic (see newTestMicPermission).
    micPermission: newTestMicPermission(),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  final _FakeReader reader = _FakeReader();
  session.presenceReader = reader.call;

  bool? accepted;
  unawaited(session.resumePairing(MobileSession(
    token: _kToken,
    endpoint: _kEndpoint,
    channel: channel,
    pcId: _kPcId,
    pcMachineUid: 'machine-test-1',
  )).then((bool ok) => accepted = ok));
  async.flushMicrotasks();
  if (accepted != true) {
    throw StateError('test setup: resumePairing did not accept (accepted=$accepted)');
  }
  return _Built(session, t, reader, rec);
}

void main() {
  group('G-15① wiring: while the session is idle and connected, it really fires once every 10 seconds', () {
    test('does not fire before 10 seconds; fires the first time at exactly 10; then once every 10 seconds after that', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);

        async.elapse(const Duration(seconds: 9, milliseconds: 999));
        expect(b.reader.calls, 0, reason: 'not yet 10 seconds');

        async.elapse(const Duration(milliseconds: 1));
        expect(b.reader.calls, 1);
        expect(b.reader.urls.single.toString(), '$_kEndpoint/api/pc/presence');
        expect(b.reader.tokens.single, _kToken);

        async.elapse(const Duration(seconds: 10));
        expect(b.reader.calls, 2);
        async.elapse(const Duration(seconds: 10));
        expect(b.reader.calls, 3);
      });
    });

    test('the answer really lands on PttSession.pcPresence (via PcPresenceTracker, the single writer)', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        expect(b.session.pcPresence.value, PcPresence.unknown);
        async.elapse(const Duration(seconds: 10));
        expect(b.session.pcPresence.value, PcPresence.online);
      });
    });
  });

  group('G-15① constraint ①: ask only while "idle and connected"', () {
    test('does not ask while RECORDING; after returning to IDLE the next tick asks as usual (positive control: the probe is not blind)', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        expect(b.session.fsm.session, SessionState.idle);

        unawaited(b.session.pttDown());
        async.flushMicrotasks();
        expect(b.session.fsm.session, SessionState.recording);
        // Feed one chunk before AudioCapture's 1500ms dead-capture watchdog
        // fires — otherwise a FakeAudioRecorder that never produces bytes
        // reads as a dead mic and the FSM auto-aborts back to IDLE on its
        // own, which would make this test pass for the WRONG reason (idle,
        // not "still recording and correctly not polled").
        b.recorder.feed(makePcm(3200));
        async.elapse(const Duration(seconds: 10));
        expect(b.session.fsm.session, SessionState.recording,
            reason: 'still recording — the feed above only keeps the dead-mic watchdog from firing, it is not "done speaking"');
        expect(b.reader.calls, 0, reason: 'must not ask while recording');

        unawaited(b.session.pttCancel());
        async.flushMicrotasks();
        expect(b.session.fsm.session, SessionState.idle);

        async.elapse(const Duration(seconds: 10));
        expect(b.reader.calls, 1, reason: 'after returning to idle the next tick asks as usual');
      });
    });

    test('does not ask while the socket is down (and the reconnect ladder\'s automatic retries during the outage must not quietly bring it back)', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        // After a real pairing `reconnect.start()` is really running (that is
        // exactly the effect of this card moving [_startPresencePoll] onto
        // `onAccepted`) — if the later automatic reconnects are not also
        // blocked, the ladder will reconnect itself within 30 seconds, that
        // onAccepted will restart the timer, and this case cannot prove
        // "does not ask while disconnected".
        b.transport.connectSucceeds = false;
        b.transport.pushStatus(SocketStatus.disconnected);
        expect(b.session.fsm.connection, isNot(ConnectionState.connected));
        async.elapse(const Duration(seconds: 30));
        expect(b.reader.calls, 0);
      });
    });
  });

  group("G-15① constraint ③: the InstanceTarget.cloudNotes (channel=='saas') row does not fire", () {
    test("channel:'saas' ⇒ does not ask even once", () {
      fakeAsync((FakeAsync async) {
        final _Built cloud = _pair(async, channel: 'saas');
        async.elapse(const Duration(seconds: 30));
        expect(cloud.reader.calls, 0);
      });
    });

    test("positive control: channel:'standalone' (a real PC) asks as usual — the probe itself is not broken", () {
      fakeAsync((FakeAsync async) {
        final _Built pc = _pair(async, channel: 'standalone');
        async.elapse(const Duration(seconds: 10));
        expect(pc.reader.calls, 1);
      });
    });
  });

  group('G-15① constraint ②: cannot ask ⇒ unknown, never reuse the previous answer', () {
    test('first online, next Reader answers unknown directly (simulating 404/401/network flap/wrong field)'
        ' ⇒ assert it becomes unknown, does not stay online', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        async.elapse(const Duration(seconds: 10));
        expect(b.session.pcPresence.value, PcPresence.online);

        b.reader.answerOnceWith(PcPresenceReading.unknown);
        async.elapse(const Duration(seconds: 10));
        expect(b.session.pcPresence.value, PcPresence.unknown);
      });
    });

    test('id mismatch: the pc_id the server echoed does not match the PC this session paired with ⇒ not an answer, lands unknown', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async); // paired with pc-test-1
        b.reader.answerOnceWith(
          const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-OTHER'),
        );
        async.elapse(const Duration(seconds: 10));
        expect(b.session.pcPresence.value, PcPresence.unknown);
      });
    });
  });

  group('can catch Error (not only Exception) — the RV-89 shape', () {
    test('presenceReader throwing a real Error (that does not implement Exception) does not crash the tick', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        // UnsupportedError / ArgumentError both implement `Error` and neither
        // implements `Exception` —
        // exactly the shape of RV-89's true root cause (`HttpClient.getUrl`
        // on `ws://` throws `ArgumentError`, the one `on Exception` cannot catch).
        b.reader.throwOnceWith(UnsupportedError('simulated Error, not Exception'));

        expect(() => async.elapse(const Duration(seconds: 10)), returnsNormally);
        expect(b.session.pcPresence.value, PcPresence.unknown);

        // One Error must not take the poll itself down with it — the next tick still happens.
        async.elapse(const Duration(seconds: 10));
        expect(b.reader.calls, 2);
        expect(b.session.pcPresence.value, PcPresence.online);
      });
    });
  });

  // ── the knob is LIVE, not merely present ─────────────────────────────────
  //
  // 🔴 WHY THIS GROUP EXISTS. When the bounded retry landed, this poll started
  // reading `kSessionPollPresenceBudget.perAttemptTimeout` (2.5 s) directly, and
  // `PttSession.presencePollTimeout` (3 s) stopped being read by anything at
  // all. Nothing went red: every existing case here asserts WHETHER the reader
  // was called and WHAT it answered, and none of them looked at the budget it
  // was handed. A control that changes nothing is worse than no control (the
  // standing rule), and it is invisible to a suite that only measures effects
  // the control does not reach.
  //
  // ⇒ The first test alone would NOT have caught it: while the two numbers
  //   agree, reading either one gives the same answer. Only MUTATING the field
  //   and watching the budget follow can tell a live knob from a dead one, and
  //   that is the second test.
  //
  // REVERSE CONTROL (executed 2026-08-16). Break: in ptt_presence_poll.dart put
  // `budget: kSessionPollPresenceBudget` back, i.e. read the constant instead of
  // the field. OBSERVED `+10 -2: Some tests failed.` — the two MUTATING cases:
  //   "changing the field changes the budget — this is what proves it is read"
  //     Expected: Duration:<0:00:01.234000>
  //       Actual: Duration:<0:00:03.000000>
  //   "the retry keeps using it for EVERY attempt, not just the first"
  //     Expected: [Duration:0:00:01.234000, Duration:0:00:01.234000]
  //       Actual: [Duration:0:00:03.000000, Duration:0:00:03.000000]
  // CONTROL-ON-CONTROL: "the per-attempt budget handed to the reader IS
  // PttSession.presencePollTimeout" stayed GREEN, and so did every other case in
  // this file. That is exactly the point being made above: with both numbers at
  // 3 s, a non-mutating assertion cannot tell a live knob from a dead one — only
  // the two that change the field can, which is why they exist.
  group('G-15①: presencePollTimeout is the per-attempt budget, and is READ', () {
    test('the per-attempt budget handed to the reader IS '
        'PttSession.presencePollTimeout', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        async.elapse(const Duration(seconds: 10));
        expect(b.reader.calls, 1);
        expect(b.reader.timeouts.single, b.session.presencePollTimeout);
        // …and the declared constant agrees with the field, which is the whole
        // reason the field could go unread without anyone noticing. Two
        // spellings of one number: if one moves, this fails until both do.
        expect(
          b.session.presencePollTimeout,
          kSessionPollPresenceBudget.perAttemptTimeout,
        );
      });
    });

    test('changing the field changes the budget — this is what proves it is read',
        () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        // A value no constant in this repo holds, so a pass cannot be a
        // coincidence of two numbers happening to agree.
        b.session.presencePollTimeout = const Duration(milliseconds: 1234);
        async.elapse(const Duration(seconds: 10));
        expect(b.reader.timeouts.single, const Duration(milliseconds: 1234));
        expect(
          b.reader.timeouts.single,
          isNot(kSessionPollPresenceBudget.perAttemptTimeout),
        );
      });
    });

    test('the retry keeps using it for EVERY attempt, not just the first', () {
      fakeAsync((FakeAsync async) {
        final _Built b = _pair(async);
        b.session.presencePollTimeout = const Duration(milliseconds: 1234);
        // A retryable miss is the only thing that buys a second attempt — an
        // answered reading is a measurement and is never re-asked.
        b.reader.answerOnceWith(const PcPresenceReading(
          presence: PcPresence.unknown,
          miss: PcPresenceMiss.timeout,
        ));
        async.elapse(const Duration(seconds: 10)); // the tick fires AT 10 s…
        // …and the 500 ms backoff before attempt 2 lands after it, so it needs
        // its own elapse. One second, not another ten: ten would fire the NEXT
        // tick and the second call would prove nothing about the retry.
        async.elapse(const Duration(seconds: 1));
        expect(b.reader.calls, 2, reason: 'a retryable miss must buy attempt 2');
        expect(b.reader.timeouts, <Duration>[
          const Duration(milliseconds: 1234),
          const Duration(milliseconds: 1234),
        ]);
      });
    });
  });
}
