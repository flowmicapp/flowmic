// card HANGUP-3 — on a phone that declared `stt.segment_not_transcribed`, the
// server's STT_SEGMENT_NOT_TRANSCRIBED (sent before the terminal final) renders
// its own sentence in the banner slot, and the row with the words that WERE
// transcribed is still built. Wire-to-render, the same harness as
// empty_final_cause_banner_test.dart (its header says why the join is the unit).
//
// The OLD-phone half is the reason for the gate, measured on this code before
// the sentence existed: the same frames rendered 「转写引擎报错（STT_SEGMENT_NOT_TRANSCRIBED）」
// for ~4 s beside an otherwise normal row. That is why the server only sends the
// code to a phone whose admission frame declared it (declared_client_capabilities_test.dart).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
// `ConnectionState` is also a Flutter widgets name; the show-list keeps the
// production one and leaves the framework's alone (banner_queue_test's pattern).
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_banner_sources.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
// `hide ConnectionState`: Flutter exports a name of its own and the production
// enum is the one every row here means.
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

// The rendered rows read the DEFAULT UI locale, which is what `ChatFlowPage`
// paints with — asserting an English string against a zh-painted page finds
// nothing and looks exactly like a missing banner (measured while writing this
// file). The nine-locale rows below use the whole registry instead.
const AppStrings _zh = AppStringsZh();

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// Real PttSession + real ChatController + the production banner adapter. Only
/// the socket and the recorder are doubles, so every hop under test is shipped
/// code.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.store = newTestStore(owner: _FakeOwner('inst-empty1', 'Study PC'));
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    return r;
  }

  BannerQueue banners(AppStrings s) => chatBannerSources(
    controller: controller,
    strings: s,
    onRetrySendFailure: null,
  );

  /// A TERMINAL `stt:final` carrying no text, byte-shaped as `SttFinalSchema`
  /// puts it on the wire. `emptyReason` omitted ⇒ the pre-card frame, which is
  /// also every relay and every server built before this card.
  void emptyFinal({String? emptyReason}) => transport.pushIncoming(
    FlowMicEvents.sttFinal,
    <String, Object?>{
      'text': '',
      'confidence': 0.0,
      'language': 'fr',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 3060,
      'empty_reason': ?emptyReason,
    },
  );

  /// A terminal `stt:error` — the frame that must keep OWNING the explanation.
  void sttError(String code) => transport.pushIncoming(
    FlowMicEvents.sttError,
    <String, Object?>{'code': code, 'message': 'x', 'retryable': false},
  );

  void teardownSync() {
    debugCancelBannerAutoHideTimers(controller);
    controller.dispose();
    destination.dispose();
    store.dispose();
  }
}

Finder _renderedBanner(String message) => find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(message),
);

/// After render, did this text overflow its own `maxLines` (= the user sees an
/// ellipsis instead of the sentence)? The 0.2.53 lesson: 1,259 tests were green
/// while the screen showed three letters, because they all read `Text.data`.
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

void _releaseTimers(_Rig r) {
  r.session.fsm.onJustDoneTimeout();
  r.controller.delivery.dispose();
  debugCancelBannerAutoHideTimers(r.controller);
  r.session.debugStopIdlePresencePoll();
  // AW-1b — `onPttDown()` above armed the health tracker's 500ms ticker;
  // `onJustDoneTimeout()` two lines up does not produce the recordingEnded
  // edge that would cancel it (PROCESSING -> JUST_DONE already happened on
  // the earlier `onPttUp()`/terminal final, so the FSM's `session` was never
  // `recording` at THIS call — the ticker armed on the ORIGINAL onPttDown is
  // still live).
  debugCancelAsrHealthTicker(r.controller);
}

void main() {
  setUp(DiagLog.instance.clear);

  testWidgets('🔴 the code before a final with words: its own sentence, rendered whole, and the row is built',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    addTearDown(() async {
      r.teardownSync();
      await r.session.dispose();
      await r.transport.close();
    });
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    r.session.fsm.onPttDown();
    await tester.pump();
    r.session.fsm.onPttUp();
    await tester.pump();
    final Finder f = _renderedBanner(_zh.sttStallSegmentNotTranscribed);
    expect(f, findsNothing); // positive control for the finder: nothing there before the frame
    r.sttError('STT_SEGMENT_NOT_TRANSCRIBED');
    await tester.pump();
    r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '大家好，今天说一下', 'confidence': 1.0, 'language': 'zh',
      'segment_idx': 0, 'is_segment': false, 'duration_ms': 3000,
    });
    await tester.pump();

    expect(f, findsOneWidget);
    expect(_clipped(tester, f), isFalse);
    // Not the raw-identifier fallback an old phone shows.
    expect(_renderedBanner(_zh.sttStallEngineErrorCoded('STT_SEGMENT_NOT_TRANSCRIBED')), findsNothing);
    // The words that were transcribed are still a row.
    expect(r.store.entries.map((e) => e.sourceText), contains('大家好，今天说一下'));
    _releaseTimers(r);
  });
}
