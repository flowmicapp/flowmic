// rc-phone-fixes (2026-11-07) — Deliver on a dropped link: the words belong to the
// queue, not the box. Contract: doc 15 `15-RECEIPT-STATES.md` §2.0.1-c, last block.
//
// Before: the item was queued AND the same words stayed in the box. Back → 「Discard
// unsent content?」 → Discard, and the queue still sent them (measured `inject_origin:
// live`, so the computer typed them). Or a second Deliver minted a second id, and the
// computer received both: two ids are two sends, and the desktop's dedup cannot join
// them.
//
// These mount the real chat page. The row is what the user has left once the box
// clears, so what it paints is asserted, not the store.
//
// Reverse controls (2026-11-07, this file only; each measured red, then restored and
// rerun green, same command):
//   · the box no longer cleared (`_sendBuffer`'s linkDown branch disabled) → 「Discard
//     no longer applies」 red at 「Expected: empty Actual: 'the sentence on a dropped
//     link'」, and 「Deliver cannot produce a second id」 red at 「Expected:
//     ComposeSendFailure.emptyBuffer Actual: <null>」, a second delivery accepted: the
//     two defects as reported;
//   · `_keepDraftOnARow` not called → the edited-draft case red, 「Expected: an object
//     with length of <2> ... has length of <1>」: the edited words are on no row;
//   · the branch widened to other failures → the known-down and no-queue-item cases
//     red, 「Expected: 'the sentence on a dropped link' Actual: ''」: words with no
//     copy anywhere vanish from the box.

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _words = 'the sentence on a dropped link';

class _Owner implements InstanceOwnerProbe {
  const _Owner(this._s);
  final PttSession _s;
  @override
  String? get instanceId => _s.connectedInstanceId;
  @override
  String? get instanceName => _s.pcDisplayName;
}

class _Rig {
  _Rig({bool paired = true}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    if (paired) giveSessionAPairedIdentity(session);
    timeline = newTestStore(owner: _Owner(session));
    c = ChatController(
      outboxStore: items,
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
      // This rig has no reconnect ladder, and `_onSessionLost` sends a page away at
      // once when none runs. A real one is running by then, so the page stays.
      sessionLostAfter: const Duration(minutes: 30),
    );
  }

  final OutboxStore items = newTestOutboxStore();
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController c;
  int leaves = 0;
  late AppStrings s;

  Future<void> open(WidgetTester t) async {
    t.view.physicalSize = const Size(420 * 3, 1800 * 3);
    t.view.devicePixelRatio = 3.0;
    addTearDown(t.view.reset);
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final AppSettingsController settings =
        AppSettingsController(prefs: await SharedPreferences.getInstance());
    s = AppStrings.of(settings.locale);
    await c.outbox.load();
    await c.loadSendPolicy();
    transport.pushStatus(SocketStatus.connected);
    session.noteRoomJoined(atHomeNode: true);
    await _flush(t);
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => TextButton(
              onPressed: () => Navigator.of(context).push<void>(
                MaterialPageRoute<void>(
                  builder: (_) => ChatFlowPage(
                    controller: c,
                    appSettings: settings,
                    onBack: () => leaves++,
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    await t.pump();
  }

  Future<void> pressDeliverOnADeadLink(WidgetTester t, String text) async {
    c.setBuffer(text);
    await t.pump();
    transport.defaultAck = <String, Object?>{'ok': false};
    // The real press: a manual draft opens the edit sheet, and its Deliver is the
    // one production caller of `sendBuffer` (it also collapses the sheet).
    await t.tap(find.byKey(const ValueKey<String>('compose.card.deliver')));
    await t.pump();
    await _elapse(t, const Duration(seconds: 15));
    expect(c.delivery.sendPending, isFalse, reason: 'premise: the press is over');
  }

  Future<void> linkBack(WidgetTester t) async {
    transport.defaultAck = <String, Object?>{'ok': true};
    transport.pushStatus(SocketStatus.connected);
    session.noteRoomJoined(atHomeNode: true);
    await _elapse(t, const Duration(seconds: 3));
  }

  List<Map<Object?, Object?>> get frames => transport.emitted
      .where((EventEnvelope e) => e.name == FlowMicEvents.injectRequest)
      .map((EventEnvelope e) => e.data! as Map<Object?, Object?>)
      .toList();

  /// The strings painted on the tile that shows [rowText].
  List<String> paintedOn(WidgetTester t, String rowText) {
    final Finder tile = find.ancestor(
      of: find.text(rowText),
      matching: find.byType(ChatMessageTile),
    );
    expect(tile, findsOneWidget, reason: 'the words "$rowText" are on a row');
    return t
        .widgetList<Text>(find.descendant(of: tile, matching: find.byType(Text)))
        .map((Text x) => x.data ?? x.textSpan?.toPlainText() ?? '')
        .toList();
  }

  Future<void> close(WidgetTester t) async {
    c.session.debugStopIdlePresencePoll();
    c.outbox.debugCancelNoAnswerRetries();
    await t.pumpWidget(const SizedBox());
    bool done = false;
    unawaited(() async {
      await c.dispose();
      await session.dispose();
      timeline.dispose();
      await transport.close();
      done = true;
    }());
    for (int i = 0; i < 200 && !done; i++) {
      await t.pump(const Duration(seconds: 1));
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    }
    expect(done, isTrue, reason: 'fixture: teardown finished');
  }
}

Future<void> _flush(WidgetTester t) async {
  for (int i = 0; i < 12; i++) {
    await t.pump();
  }
}

Future<void> _elapse(WidgetTester t, Duration span) async {
  for (Duration d = Duration.zero; d < span; d += const Duration(seconds: 1)) {
    await t.pump(const Duration(seconds: 1));
    await t.runAsync(() => Future<void>.delayed(Duration.zero));
  }
  await _flush(t);
}

const Timeout _slow = Timeout(Duration(minutes: 2));

void main() {
  testWidgets('🔴 Discard no longer applies: the box is empty, the words are on the ✗ '
      'row, and back simply leaves', (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    await r.pressDeliverOnADeadLink(t, _words);

    expect(r.c.buffer, isEmpty, reason: 'the queue owns these words now');
    expect(r.c.outbox.owedEntryIds, contains(r.timeline.entries.single.id),
        reason: 'premise: the queue item is alive');

    final List<String> painted = r.paintedOn(t, _words);
    expect(painted, contains('✗ ${r.s.statusFailed}'), reason: 'ruling ⑩');
    expect(painted, contains(r.s.composeSendError(ComposeSendFailure.notConnected)));
    expect(find.text(r.s.resendAction), findsOneWidget, reason: 'the row keeps Resend');

    final NavigatorState nav = t.state(find.byType(Navigator).last);
    await nav.maybePop();
    await t.pump();
    expect(find.text(r.s.discardUnsentConfirm), findsNothing, reason: 'nothing to discard');
    await _elapse(t, const Duration(seconds: 2));
    expect(find.byType(ChatFlowPage), findsNothing);
    expect(r.leaves, 1);
    await r.close(t);
  }, timeout: _slow);

  testWidgets('🔴 Deliver cannot produce a second id: after the link returns there is '
      'nothing left to deliver, and the computer gets one frame', (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    await r.pressDeliverOnADeadLink(t, _words);
    await r.linkBack(t);
    expect(r.frames, hasLength(1), reason: 'premise: the queue sent its one copy');

    final ComposeSendFailure? again = await r.c.sendBuffer();
    await _elapse(t, const Duration(seconds: 2));

    expect(again, ComposeSendFailure.emptyBuffer);
    expect(r.frames, hasLength(1));
    expect(r.timeline.entries, hasLength(1), reason: 'no second row either');
    await r.close(t);
  }, timeout: _slow);

  testWidgets('the row\'s Resend reuses the queue item: one id, the words on the wire',
      (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    await r.pressDeliverOnADeadLink(t, _words);
    r.transport.defaultAck = <String, Object?>{'ok': true};
    r.transport.pushStatus(SocketStatus.connected);
    await _flush(t);

    await t.tap(find.text(r.s.resendAction));
    await _elapse(t, const Duration(seconds: 2));

    expect(r.frames, hasLength(1));
    expect(r.frames.single['text'], _words);
    await r.close(t);
  }, timeout: _slow);

  testWidgets('🔴 the queue gives the item up: the words are still on the row, Copy gets '
      'them, and Resend sends them as a new delivery', (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    await r.pressDeliverOnADeadLink(t, _words);
    final TimelineEntry row = r.timeline.entries.single;
    await t.runAsync(() async {
      final OutboxItem item = (await r.items.loadPending()).single;
      await r.c.outbox.settle(
        correlationId: item.requestId,
        ok: false,
        code: kOutboxOverflow,
      );
    });
    await _flush(t);
    expect(r.c.outbox.owedEntryIds, isNot(contains(row.id)), reason: 'premise: given up');
    r.paintedOn(t, _words);

    String? clipboard;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform,
        (MethodCall call) async {
      if (call.method == 'Clipboard.setData') {
        clipboard = (call.arguments as Map<Object?, Object?>)['text'] as String?;
      }
      return null;
    });
    addTearDown(() => t.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    await t.longPress(find.text(_words));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    await t.tap(find.text(r.s.entryCopy));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    await _flush(t);
    expect(clipboard, _words);

    r.transport.defaultAck = <String, Object?>{'ok': true};
    r.transport.pushStatus(SocketStatus.connected);
    await _flush(t);
    await t.tap(find.text(r.s.resendAction));
    await _elapse(t, const Duration(seconds: 2));
    expect(r.frames.map((Map<Object?, Object?> f) => f['text']), contains(_words),
        reason: 'the words go out again, under a fresh delivery');
    await r.close(t);
  }, timeout: _slow);

  testWidgets('an edited draft keeps its words: the row holds the original, a noted row '
      'holds what the user had made of it', (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    await t.runAsync(() async {
      r.session.fsm.onJustDoneTimeout();
      await r.c.pttDown();
      await r.c.pttUp();
      r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': 'what was spoken',
        'confidence': 0.95,
        'language': 'en',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 1200,
      });
      await pumpEventQueue();
    });
    await _flush(t);
    expect(r.c.buffer, 'what was spoken', reason: 'premise');

    await r.pressDeliverOnADeadLink(t, 'what the user edited it to');

    expect(r.c.buffer, isEmpty);
    expect(r.timeline.entries, hasLength(2));
    final TimelineEntry kept = r.timeline.entries.firstWhere(
      (TimelineEntry e) => e.displayText == 'what the user edited it to',
    );
    expect(kept.status, EntryStatus.noted);
    final TimelineEntry source = r.timeline.entries.firstWhere(
      (TimelineEntry e) => e.displayText == 'what was spoken',
    );
    expect(source.status, EntryStatus.failed);
    await r.close(t);
  }, timeout: _slow);

  testWidgets('an untouched spoken draft gets no extra row: the row already is the words',
      (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    await t.runAsync(() async {
      r.session.fsm.onJustDoneTimeout();
      await r.c.pttDown();
      await r.c.pttUp();
      r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': _words,
        'confidence': 0.95,
        'language': 'en',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 1200,
      });
      await pumpEventQueue();
    });
    await _flush(t);

    await r.pressDeliverOnADeadLink(t, _words);

    expect(r.c.buffer, isEmpty);
    expect(r.timeline.entries, hasLength(1));
    expect(r.timeline.entries.single.status, EntryStatus.failed);
    await r.close(t);
  }, timeout: _slow);

  testWidgets('the known-down gate is unchanged: nothing enqueued, the box keeps the words',
      (WidgetTester t) async {
    final _Rig r = _Rig();
    await r.open(t);
    r.c.setBuffer(_words);
    r.transport.pushStatus(SocketStatus.disconnected);
    await _flush(t);
    expect(r.c.canCompose, isFalse, reason: 'premise');

    final ComposeSendFailure? failure = await r.c.sendBuffer();
    await _flush(t);

    expect(failure, ComposeSendFailure.notConnected);
    expect(r.c.buffer, _words);
    expect(r.timeline.entries, isEmpty);
    await r.close(t);
  }, timeout: _slow);

  testWidgets('no queue item (the queue refused at the door): the box keeps the words',
      (WidgetTester t) async {
    final _Rig r = _Rig(paired: false);
    await r.open(t);
    r.c.setBuffer(_words);
    final ComposeSendFailure? failure = await r.c.sendBuffer();
    await _flush(t);

    expect(failure, isNot(ComposeSendFailure.linkDown), reason: 'premise');
    expect(r.c.outbox.owedEntryIds, isEmpty, reason: 'premise: nothing was enqueued');
    expect(r.c.buffer, _words);
    await r.close(t);
  }, timeout: _slow);

  testWidgets('a mode switch after the drop adds no row: the box is empty', (
    WidgetTester t,
  ) async {
    final _Rig r = _Rig();
    await r.open(t);
    await r.pressDeliverOnADeadLink(t, _words);
    r.c.setMode(FlowMode.organize);
    await _flush(t);
    expect(r.timeline.entries, hasLength(1));
    expect(r.c.outbox.owedEntryIds, contains(r.timeline.entries.single.id),
        reason: 'the queue item is not touched');
    await r.close(t);
  }, timeout: _slow);
}
