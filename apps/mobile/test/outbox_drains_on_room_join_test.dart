// 🔴 F-1 (machine 2026-08-03 real device) —— 「连接恢复后会自动投递」 is a promise nobody kept.
//
// The queue drain previously hung off the `ConnectionState.connected` rising
// edge (`onFsmChangeRouted`), and that edge only says the **socket is up**, not
// that the server has already put this connection into the room. On a real
// device the two were about 170ms apart, so every frame the drain emitted was
// **rightfully** judged `INJECT_NOT_IN_ROOM`:
//
//     04:57:23.187 socket connected
//     04:57:23.190 emit.inject        handed_to_socket=true
//     04:57:23.352 recv.inject_result ok=false error=INJECT_NOT_IN_ROOM
//     04:57:23.356 outbox.settled     state=requeued      ← and then nobody drained a second time
//
// After `requeued` nothing drains again until the user manually sends another
// line ⇒ the phone banner stays hung on 「还有 1 条待投递」, and it never becomes
// delivered on its own. This is a literal violation of the red line
// **「『待投递』仅当有持久队列兑现时才许用」**: the queue is there; the step that
// redeems it is not.
//
// ⚠️ The same defect was already fixed on the audio path (GA-04M: wait for the
// `mobile:reconnect` ack before sending a chunk). **The fix did not travel to
// the second path** — that repair was done locally at the call site and never
// turned 「joined the room」 into a subscribable fact. ⇒ rule: **when fixing an
// 「one beat early」 defect, ask 「who else needs that same later fact」**, or
// the second path will repeat it verbatim.
//
// The predicate uses `DiagLog`, not 「did a frame go out」: this test has to
// prove **whether the drain was triggered**, and whether a frame actually
// leaves still depends on addressing, the link probe, and a pile of other
// things — each of those has its own test; mixing them in would make a red
// here unable to say whose problem it is.

import 'dart:async' show unawaited;

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show SendPolicy;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  /// Speak one line. The link is down ⇒ persist before send; the item stays
  /// `queued` (that is exactly what the queue is for).
  Future<void> speak(String text) async {
    // 🔴 N1-B2 —— this line fills a premise this rig structurally cannot reach:
    // the whole case's premise is 「the link is down」, and the first thing
    // `session.pttDown` does is `if (fsm.connection != connected) return false`
    // ⇒ the `segments.clear()` inside it never ran. So the second `speak`'s
    // final shares segment_idx 0 with the first, which is **impossible on the
    // wire**: a down socket will not carry stt:final, and when the second
    // utterance is really spoken the server rebuilds the orchestrator and
    // zeroes the segment number.
    // This test is about queue drain, not STT, so only the thing `audio:start`
    // actually does is filled in.
    session.segments.clear();
    unawaited(controller.pttDown());
    unawaited(controller.pttUp());
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text, 'confidence': 0.95, 'language': 'zh',
      'segment_idx': 0, 'is_segment': false, 'duration_ms': 1200,
    });
    await _settle();
  }

  Future<void> _settle() async {
    for (int i = 0; i < 12; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<void> settle() => _settle();

  bool get drained =>
      DiagLog.instance.snapshot().any((String l) => l.contains('outbox.drain_begin'));

  Future<void> dispose() async {
    await controller.dispose();
    await session.dispose();
    timeline.dispose();
    await transport.close();
  }
}

void main() {
  setUp(DiagLog.instance.clear);

  test('🔴 the drain trigger edge is 「joined the room」, not 「socket connected」', () async {
    final _Rig rig = _Rig();
    addTearDown(rig.dispose);

    await rig.speak('这句话是断网时说的');
    expect(rig.drained, isFalse, reason: 'the link is down; there must be no drain yet');

    // ── reverse control: the old trigger edge ─────────────────────────────────
    // The socket is up, but the server has not put us in the room yet
    // (`mobile:reconnect`'s ack has not arrived). The old implementation
    // drained here, so every frame hit `INJECT_NOT_IN_ROOM`.
    rig.transport.pushStatus(SocketStatus.connected);
    await rig.settle();
    expect(
      rig.drained,
      isFalse,
      reason: '🔴 F-1: draining before joining the room ⇒ the server rightfully refuses; the item goes back to queued and nobody drains again',
    );

    // ── the actual point: the server put us in the room ──────────────────────
    // In production this is fired by `mobile:reconnect`'s `onAccepted`
    // (ptt_reconnect_ack.dart).
    rig.session.noteRoomJoined();
    await rig.settle();
    expect(
      rig.drained,
      isTrue,
      reason: 'joined the room but did not drain ⇒ nobody kept the banner sentence 「连接恢复后会自动投递」',
    );
  });

  test('every re-join must drain once — a signal that fires only once cannot save a second disconnect', () async {
    final _Rig rig = _Rig();
    addTearDown(rig.dispose);

    await rig.speak('第一句');
    rig.transport.pushStatus(SocketStatus.connected);
    rig.session.noteRoomJoined();
    await rig.settle();
    expect(rig.drained, isTrue);

    DiagLog.instance.clear();
    // Drop, then owe another line. `roomJoins` is a counter, not a boolean,
    // exactly for this: a boolean that stays true notifies nobody on the
    // second join.
    rig.transport.pushStatus(SocketStatus.disconnected);
    await rig.settle();
    await rig.speak('第二句');
    expect(rig.drained, isFalse, reason: 'down again; there must be no drain yet');
    rig.transport.pushStatus(SocketStatus.connected);
    rig.session.noteRoomJoined();
    await rig.settle();
    expect(rig.drained, isTrue, reason: 'second join did not drain ⇒ only the first disconnect can self-heal');
  });
}
