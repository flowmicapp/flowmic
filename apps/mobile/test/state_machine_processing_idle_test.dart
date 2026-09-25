// 🔴 CARD RC-M (MAIN ruling 1, 2026-09-24) — 「NO RESPONSE」 MEANS 15 s WITH NO
// STT FRAME AT ALL, AND A RECOVERY SESSION HAS NO SUCH NET.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §2, the RC-M correction under 「PROCESSING 安全网」
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.2 / §8 RC-M / §11-1
//
// The measured shape: GA-03 was a FIXED 15 s deadline armed at release. A
// relay flushing a backlog answered a recovery 26.7 s after `audio:stop`
// (interims flowing the whole time) and a live stop 19.5 s after — the phone
// had given up at 15.3 s both times, recorded `stall_timeout`, and threw away
// words it had already paid for.
//
// Pinned here on the FSM and through the real inbound dispatch
// (`ptt_inbound.dart` is the one caller of `onSttActivity`): an interim every
// 10 s keeps a 40 s wait alive; 15 s of nothing still stalls; a recovery's
// release (`endBackfill`) arms nothing and its own leg releases it.
//
// Reverse control: `onSttActivity` as a no-op and `onPttUp` ignoring `armNet`
// (the fixed 15 s net) ⇒ the first two cases go red — log in the card report.

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

void main() {
  group('FSM', () {
    late FlowmicStateMachine fsm;
    late List<SttStall> stalls;

    setUp(() {
      fsm = FlowmicStateMachine();
      stalls = <SttStall>[];
      fsm.sttStalled.listen(stalls.add);
      fsm.onSocketStatus(SocketStatus.connected);
    });
    tearDown(() => fsm.dispose());

    test('an stt frame every 10 s keeps a 40 s wait alive; the final closes it',
        () {
      fakeAsync((FakeAsync async) {
        fsm.onPttDown();
        fsm.onPttUp();
        for (int i = 0; i < 4; i++) {
          async.elapse(const Duration(seconds: 10));
          expect(fsm.session, SessionState.processing, reason: 'at ${10 * (i + 1)} s');
          fsm.onSttActivity();
        }
        fsm.onSttFinal();
        expect(fsm.session, SessionState.justDone);
        async.elapse(const Duration(seconds: 30));
        expect(stalls, isEmpty, reason: 'a relay that is answering never stalls');
      });
    });

    test('15 s with no frame at all still stalls, named `timeout`', () {
      fakeAsync((FakeAsync async) {
        fsm.onPttDown();
        fsm.onPttUp();
        async.elapse(const Duration(seconds: 10));
        fsm.onSttActivity();
        async.elapse(const Duration(milliseconds: 14900));
        expect(fsm.session, SessionState.processing,
            reason: 'positive control: 14.9 s since the last frame is not 15');
        async.elapse(const Duration(milliseconds: 200));
        expect(fsm.session, SessionState.idle);
        expect(stalls.single.reason, SttStallReason.timeout);
      });
    });

    test('a recovery release arms no net; its leg releases it without a stall',
        () {
      fakeAsync((FakeAsync async) {
        fsm.onPttDown();
        fsm.onPttUp(armNet: false);
        async.elapse(const Duration(minutes: 2));
        expect(fsm.session, SessionState.processing,
            reason: 'the wait belongs to RecoveryTimeouts, not to GA-03');
        expect(stalls, isEmpty);
        fsm.releaseProcessing();
        expect(fsm.session, SessionState.idle);
        expect(stalls, isEmpty, reason: 'the journal says it; no banner');
      });
    });

    test('a link drop during a net-less wait restores it net-less, not wedged',
        () {
      fakeAsync((FakeAsync async) {
        fsm.onPttDown();
        fsm.onPttUp(armNet: false);
        fsm.onSocketStatus(SocketStatus.reconnecting);
        fsm.onSocketStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 1));
        fsm.releaseProcessing();
        fsm.onSocketStatus(SocketStatus.connected);
        expect(fsm.session, SessionState.idle,
            reason: 'a released wait must not be restored as PROCESSING');
      });
    });
  });

  test(
      'through the inbound dispatch: interims and engine-status frames keep a '
      'live stop waiting past 15 s', () {
    fakeAsync((FakeAsync async) {
      final FakeSocketTransport t = FakeSocketTransport();
      final PttSession s = newTestSession(transport: t);
      final List<SttStall> stalls = <SttStall>[];
      s.fsm.sttStalled.listen(stalls.add);
      t.pushStatus(SocketStatus.connected);
      async.flushMicrotasks();
      s.fsm.onPttDown();
      s.fsm.onPttUp();
      for (int i = 0; i < 3; i++) {
        async.elapse(const Duration(seconds: 10));
        t.pushIncoming(
            i.isEven ? FlowMicEvents.sttInterim : FlowMicEvents.sttEngineStatus,
            i.isEven
                ? <String, Object?>{'text': '…', 'segment_idx': 0}
                : <String, Object?>{'status': 'reconnecting', 'provider': 'soniox'});
        async.flushMicrotasks();
      }
      async.elapse(const Duration(seconds: 10));
      expect(s.fsm.session, SessionState.processing,
          reason: '40 s after release, the last frame 10 s ago');
      expect(stalls, isEmpty);
      async.elapse(const Duration(seconds: 6));
      expect(stalls.single.reason, SttStallReason.timeout,
          reason: 'positive control: silence still ends it');
      s.dispose();
      async.flushMicrotasks();
    });
  });
}
