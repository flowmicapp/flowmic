// The light-record screen with a real ChatController, and a way to make a
// continuous recording on it — EXTRACTED VERBATIM from article_screen_test.dart
// (2026-08-30) so that article_copy_screen_test.dart drives the same screen
// through the same chain rather than a second rig that could drift from it.
//
// Everything below that argues (the owner, the tall surface, `runAsync`) was
// written for that file and is kept here because it is the reason the rig has
// the shape it has. See that file's header for the rule it enforces.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'di.dart';
import 'fakes.dart';

/// 🔴 THE ROWS MUST BE OWNED BY THE INSTANCE THIS SCREEN IS SCOPED TO, or the
/// page renders nothing at all and every `findsNothing` passes for the wrong
/// reason. `entriesForOwners` excludes rows with a null owner by design (card
/// F2), and `newTestStore`'s default owner has none — the first draft of the
/// screen test failed with 「Found 0 widgets with text 随口说一句」 on the
/// reverse control, which is exactly the positive control doing its job on the
/// FIXTURE rather than on the product.
///
/// Public (not `_`-prefixed): card 4 / A-3 (2026-09-01) needs the SAME
/// owner-wiring for a rig that is not [ArticleRig] (the catch-up case builds
/// its own `TimelineStore`/`ChatController` around a `RetainedAudioStore`),
/// and a second, drifting copy of this class is exactly the kind of thing
/// that stops matching this one.
class SessionOwnerProbe implements InstanceOwnerProbe {
  const SessionOwnerProbe(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class ArticleRig {
  /// [persistence] — card A-1 (2026-09-01): an app-restart test needs a
  /// SECOND rig reading the SAME disk the first one wrote, to prove a
  /// finished recording is still one card after the process is rebuilt from
  /// scratch. Optional and defaulting to a fresh in-memory store, so every
  /// existing call site (one rig, one process lifetime) is unaffected — this
  /// is the same additive-parameter shape `newTestStore` already uses.
  ArticleRig({TimelinePersistence? persistence})
      : persistence = persistence ?? InMemoryTimelinePersistence() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore(
      persistence: this.persistence,
      owner: SessionOwnerProbe(session),
    );
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      // Ruling ⑨ — continuous recording only exists where nothing is delivered.
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  /// The disk this rig's [store] reads and writes. Exposed so a SECOND rig
  /// can be built over the same one (card A-1's "restart").
  final TimelinePersistence persistence;
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  Future<String> startRecording() async {
    final String id = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    )!;
    await controller.pttDown();
    return id;
  }

  Future<void> say(String text, int idx, {required bool isSegment}) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': isSegment,
      'duration_ms': 30000,
    });
    await pumpEventQueue();
  }

  /// Three sentences, then stop — the smallest thing that is a RECORDING and
  /// not an utterance.
  Future<String> recordThreeAndStop() async {
    final String id = await startRecording();
    await say('今天先过两件事', 0, isSegment: true);
    await say('第一件是库存口径', 1, isSegment: true);
    await controller.pttUp();
    await say('第二件是采购节奏', 2, isSegment: false);
    session.endContinuous();
    return id;
  }

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
  }
}

/// 🔴 A TALL SURFACE, AND IT IS NOT COSMETIC. The timeline is a `ListView`,
/// which BUILDS ONLY WHAT FITS. On the default 800×600 surface the dock, header
/// and banner slot leave a viewport short enough that older rows are never
/// built at all — and an unbuilt row cannot be found by any finder, including
/// `skipOffstage: false`. Measured while writing the screen test: two of three
/// sentences 「passed」 `findsNothing` on a build where the collapse was not
/// running at all.
///
/// ⇒ 「先核你的尺子」 in its widget-test form: `findsNothing` over a lazy list
/// is not evidence of absence unless the list had room to build everything.
Future<void> mountLightRecordScreen(WidgetTester tester, ArticleRig r) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: r.controller)),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}
