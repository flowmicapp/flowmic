// 🔴 2026-09-04 (owner, real devices, 0.3.61, cloud relay) — 「pending delivery」
// sat there for minutes with the PC already back.
//
// F-1 (0.2.52) moved the drain off `ConnectionState.connected` onto
// `PttSession.roomJoins`, and that was right: the socket being up is one beat
// earlier than the server having put this connection in a room. But `roomJoins`
// only ever answers 「THIS PHONE got in」. On the cloud leg the relay does not
// drop when the PC quits, so the phone never leaves its room:
//
//   relay   audio:start: fanned-out utterance has no PC in this room
//   relay   inject:request but no PC in room
//   phone   「Pending delivery · Resend」   ← and the banner promising redelivery
//   PC      (relaunched) pc:reconnect ack roster on cloud — 1 phone(s)
//   PC      pc:mobile-joined
//   phone   「Pending delivery」 … for minutes
//   phone   (made to leave and re-enter the room) inject:request
//           inject_origin=deferred, 0.7 s later
//
// ⇒ the missing edge is not a connection edge at all: it is 「the DESTINATION is
// back」. This file pins that edge. The premise every case here holds is the one
// the room-join test structurally cannot hold: **the phone stays in the room the
// whole time**, so `roomJoins` never fires again and only the new edge can
// explain a drain.
//
// 🔴 THE PREDICATE IS `DiagLog`, NOT 「did a frame leave」 — the same choice
// `outbox_drains_on_room_join_test.dart` made and for the same reason: whether a
// frame actually leaves also depends on addressing, the link probe and several
// other gates that have their own tests, and mixing them in would make a red
// here unable to say whose fault it is. `outbox.drain_begin` is written by
// `_drainOnePass` only once it has queued work in hand, and `outbox.link_up` is
// written by the edge itself on both branches — so 「the edge never fired」 and
// 「the edge fired and chose not to drain」 are distinguishable afterwards, which
// is exactly the distinction the empty-queue case below is about.
//
// ── REVERSE CONTROL [measured] 2026-09-04, this machine = dev-pc-a ────
// Method: in `session/delivery_link_up.dart`, comment out the one line
// `_pcPresence.addListener(_onPcPresence);` — i.e. keep the class, the wiring
// and the room-join half, and remove ONLY the new edge. Result: EXIT=1, **3 of
// 3 red**, the first case verbatim:
//
//   Expected: <1>
//     Actual: <0>
//    Which: the PC came back and nothing drained the queue — the banner
//           「they will be sent when the link is back」 is a promise nobody keeps
//           (F-1 in its second form)
//
// 🔴 **I expected the third case to stay green and it did not, and the
// measurement is right where my expectation was wrong.** The reasoning was 「it
// asserts an ABSENCE (no drain), and removing the edge only makes the absence
// more absent」. True of its second assertion — and its FIRST assertion is the
// positive control, which asserts the edge fired at all, and that is exactly
// what the reverse control removes. So the case reddens on its own control
// line (`the edge itself did not fire, so the 「did not drain」 assertion below
// proves nothing`) and never reaches the absence. That is the control doing its
// job, not a badly aimed test — but a file-wide red does cost some of the
// 「a red here says whose fault it is」 sharpness, so the distinction is in the
// reasons, not in the pass/fail pattern: only the first two reasons name the
// product defect.
//
// Restored afterwards (`REVERSE-CONTROL-2026-09-04` grep in lib/ = 0),
// `flutter analyze` clean, this file 3/3 green again.

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pc_presence.dart' show PcPresence;
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

  /// Production boot order (main.dart fires this unawaited). It is awaited here
  /// for one reason and it is not tidiness: until it returns,
  /// `pendingCountIsKnown` is false and the edge deliberately drains WITHOUT
  /// consulting the count — so an empty-queue case that skipped this would be
  /// asserting on the pre-load escape hatch rather than on the count check.
  Future<void> boot() => controller.outbox.load();

  /// The server admitted this phone to the room. In production this is
  /// `mobile:reconnect`'s `onAccepted` / a `pair()` success.
  Future<void> enterRoom() async {
    transport.pushStatus(SocketStatus.connected);
    session.noteRoomJoined(atHomeNode: true);
    await settle();
  }

  Future<void> speak(String text) async {
    session.segments.clear();
    unawaited(controller.pttDown());
    unawaited(controller.pttUp());
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text, 'confidence': 0.95, 'language': 'zh',
      'segment_idx': 0, 'is_segment': false, 'duration_ms': 1200,
    });
    await settle();
  }

  /// The relay's answer when there is no PC in the room
  /// (`relay.handler.ts` `answerReject('INJECT_PC_OFFLINE', …)`, which always
  /// sends `mode:'cached'`). Two things happen off this one frame, and the case
  /// below needs both: the item is NOT terminal, so it goes back to `queued`;
  /// and `PcPresenceTracker.noteInjectResult` learns the PC is gone.
  Future<void> relayRefusesNoPcInRoom() async {
    transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': false,
      'mode': 'cached',
      'error': 'INJECT_PC_OFFLINE',
      'entry_id': lastEmittedEntryId,
    });
    await settle();
  }

  /// The PC is in its room again. `focus:state` is used because **only the PC
  /// produces that frame** (`ptt_inbound.dart`'s `noteFocusState`) — it is one
  /// of the five wire facts that write `PcPresence`, and the cheapest of them to
  /// state honestly in a test. The idle `GET /api/pc/presence` poll reaches the
  /// same value through a different door; this file is about the consumer, not
  /// about which of the writers spoke.
  Future<void> pcBackInRoom() async {
    transport.pushIncoming(FlowMicEvents.focusState, <String, Object?>{
      'window_title': 'Untitled - Notepad',
      'process_name': 'Notepad',
    });
    await settle();
  }

  /// The `entry_id` on the LAST `inject:request` this phone actually emitted —
  /// read off the wire rather than guessed from the store, so a refusal is
  /// correlated the way the relay would correlate it.
  String? get lastEmittedEntryId {
    for (final EventEnvelope e in transport.emitted.reversed) {
      if (e.name != FlowMicEvents.injectRequest) continue;
      final Object? data = e.data;
      if (data is! Map) continue;
      final Object? id = data['entry_id'];
      if (id is String && id.isNotEmpty) return id;
    }
    return null;
  }

  Future<void> settle() async {
    for (int i = 0; i < 12; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  int get drains => DiagLog.instance
      .snapshot()
      .where((String l) => l.contains('outbox.drain_begin'))
      .length;

  int get linkUpEdges => DiagLog.instance
      .snapshot()
      .where((String l) => l.contains('outbox.link_up'))
      .length;

  Future<void> dispose() async {
    await controller.dispose();
    await session.dispose();
    timeline.dispose();
    await transport.close();
  }
}

void main() {
  setUp(DiagLog.instance.clear);

  test('🔴 the PC coming back into the room drains the queue exactly once, with the phone never leaving it', () async {
    final _Rig rig = _Rig();
    addTearDown(rig.dispose);
    await rig.boot();
    await rig.enterRoom();

    await rig.speak('说这句时电脑不在');
    // The relay had no PC to hand it to. Not terminal ⇒ the item is owed again.
    await rig.relayRefusesNoPcInRoom();
    expect(
      rig.session.pcPresence.value,
      PcPresence.offline,
      reason: 'premise: the phone has measured evidence the PC is not in the room',
    );

    // ── the premise the room-join edge cannot cover ──────────────────────────
    // Nothing about this phone's own membership changes from here on. On the
    // cloud leg that is not a contrivance, it is the normal case: the relay
    // stays up, so the socket never drops and `roomJoins` never fires again.
    DiagLog.instance.clear();
    expect(rig.drains, 0, reason: 'nothing may have drained before the PC came back');

    await rig.pcBackInRoom();

    expect(
      rig.drains,
      1,
      reason: 'the PC came back and nothing drained the queue — the banner 「they will be sent when the link is back」 is a promise nobody keeps (F-1 in its second form)',
    );
  });

  test('the same evidence arriving again is not a second edge — one drain per return, not one per frame', () async {
    final _Rig rig = _Rig();
    addTearDown(rig.dispose);
    await rig.boot();
    await rig.enterRoom();
    await rig.speak('第一句');
    await rig.relayRefusesNoPcInRoom();

    DiagLog.instance.clear();
    await rig.pcBackInRoom();
    // Every window switch on the PC produces another `focus:state`. Presence is
    // already `online`, so these are repeats of a fact we hold, not news.
    await rig.pcBackInRoom();
    await rig.pcBackInRoom();

    expect(
      rig.linkUpEdges,
      1,
      reason: 'the drain edge fired once per FRAME instead of once per return — traffic on the PC now sets the drain schedule',
    );
  });

  test('an empty queue and the PC comes back: the edge fires, and it declines to drain', () async {
    final _Rig rig = _Rig();
    addTearDown(rig.dispose);
    await rig.boot();
    await rig.enterRoom();
    // Nothing is owed. Take the PC away and bring it back with the queue empty.
    await rig.relayRefusesNoPcInRoom(); // no entry_id to correlate: presence only
    DiagLog.instance.clear();

    await rig.pcBackInRoom();

    // 🔴 Positive control FIRST. Without it, `drains == 0` below would also be
    // green if the edge had never fired at all — i.e. the assertion would pass
    // for the very defect the first case exists to catch.
    expect(
      rig.linkUpEdges,
      1,
      reason: 'the edge itself did not fire, so the 「did not drain」 assertion below proves nothing',
    );
    expect(
      rig.drains,
      0,
      reason: 'an empty queue was drained anyway — every reconnect now touches the store for nothing',
    );
  });
}
