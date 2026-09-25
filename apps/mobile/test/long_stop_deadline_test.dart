// 🔴 CODEX RC6 REVIEW ③ (P2) — THE LONG-RECORDING STOP WAIT IS A DEADLINE FROM
// THE STOP, NOT A TIMER THAT ACTIVITY OR A RECONNECT RENEWS.
//
// SPEC-REF:
//   Codex review of 8c0d879a..bee886be (2026-09-25), item 3 (dispatch; not in the tree)
//   docs/rebuild/08-MOBILE-SPEC.md §2 (the RC6 correction under RC-M; the RC7 note)
//   lib/src/signaling/state_machine.dart `onPttUp(netAtLeast:)`
//   lib/src/ptt/ptt_unheard_tail.dart `_longStopNet` (`kLongStopWaitCap`)
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// RC6 fed the 5 minute cap to the state machine's idle net, which every stt
// frame restarts and a restored link re-arms from zero. So a relay that keeps
// sending engine-status, or a link that blinks, kept 「processing」 up past five
// minutes, and RC-P's held tail kept the recovery off the wire all that time.
// The rig's `longStopCeiling` stands in for the 5 minutes (2 s here): the
// deadline must fall 2 s after the stop whatever arrives in between.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const Duration _cap = Duration(seconds: 2);

Future<SessionState> _stateAfterActivity(Future<void> Function(Rc3Rig r) during) async {
  final Rc3Rig r = await Rc3Rig.open(longStopCeiling: _cap);
  try {
    r.relay.onStop = (_) {}; // the relay never answers
    await r.begin();
    await r.feedMs(20000);
    await r.segment('第一段。', 0, 20000);
    await r.feedMs(5000);
    await r.controller.pttUp();
    expect(r.session.fsm.session, SessionState.processing, reason: 'positive control: waiting');
    await during(r);
    return r.session.fsm.session;
  } finally {
    await r.dispose();
  }
}

void main() {
  testWidgets('🔴 Codex rc6 ③: frames keep arriving before the deadline ⇒ processing still ends at it',
      (WidgetTester tester) async {
    late final SessionState s;
    await tester.runAsync(() async {
      s = await _stateAfterActivity((Rc3Rig r) async {
        // An engine-status frame every 0.6 s, the last one just before the deadline.
        for (int i = 0; i < 4; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 600));
          await r.push(FlowMicEvents.sttEngineStatus,
              <String, Object?>{'status': 'reconnecting', 'provider': 'soniox', 'retry_count': i + 1});
        }
        await Future<void>.delayed(const Duration(milliseconds: 300)); // 2.7 s after the stop
      });
    });
    expect(s, isNot(SessionState.processing),
        reason: 'the stop wait was renewed by every frame (an idle timer, not a deadline)');
  });

  testWidgets('🔴 Codex rc6 ③: a brief link drop inside the wait ⇒ processing still ends at the deadline',
      (WidgetTester tester) async {
    late final SessionState s;
    await tester.runAsync(() async {
      s = await _stateAfterActivity((Rc3Rig r) async {
        await Future<void>.delayed(const Duration(milliseconds: 1500));
        r.relay.pushStatus(SocketStatus.disconnected);
        await Future<void>.delayed(const Duration(milliseconds: 300));
        r.relay.pushStatus(SocketStatus.connected); // inside the drop grace: the session is restored
        await Future<void>.delayed(const Duration(milliseconds: 900)); // 2.7 s after the stop
      });
    });
    expect(s, isNot(SessionState.processing),
        reason: 'the restored session re-armed the wait from zero');
  });
}
