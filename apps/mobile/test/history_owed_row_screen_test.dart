// NR-284 — the all-history page says what the chat page says about a row the
// delivery queue is still working on (doc 15 `15-RECEIPT-STATES.md` §2.0.1-c,
// the NR-284 block; R11).
//
// The defect: the page held only a TimelineStore and passed `owed: false` and
// `queued: false`, so a row the phone was still retrying, with no answer from
// the computer, wore a red ✗ here while the chat page said 「Pending · no answer
// yet」. Every test the two faces already had was honestly green: they mounted a
// lone ChatMessageTile or the chat screen, and never this one.
//
// ⇒ The deliverable is a screen, so these mount it (CLAUDE.md anti-façade ⑥),
// and the first test arrives through the REAL [FlowMicApp] and the history icon,
// because `main_page_builders.dart` `_buildHistory` is the line that decides
// which queue this page sees and no other test executes it (the connections page
// suites all hand in a fake `historyPageBuilder`).
//
// Tool notes (each of these has fooled this repo before):
//   · `find.text(pill)` is scoped to the row's own tile: 「✗ exists somewhere on
//     the page」 would be satisfied by the wrong row.
//   · The canvas is tall, so 「not found」 means not drawn, not 「not built yet」
//     (ListView); each test also has a positive control on a row that DOES wear ✗.
//   · The strings are the exact pill as painted (`StatusPill`: glyph, space,
//     word), not fragments that a correct row could also contain.
//
// Reverse controls (2026-11-07, this file only; each measured red, then restored
// and rerun green):
//   · `owed: false` back in history_page.dart → all three red, first at 「Found 0
//     widgets with text "⏳ Pending · no answer yet"」: the defect as reported;
//   · `queued: false` back → the first red, at 「Found 0 widgets with text "📤
//     Pending · queued"」;
//   · `queue.changes` out of the page's merge → only the third red: nothing else
//     repaints the page when the queue moves and no row is written;
//   · `_buildHistory` handing the page an empty queue → the first red, the third
//     green: only the real-app test sees that line. (The second went red in that
//     run as fallout of the first's unfinished app tree; alone it is green.)

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/main.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart' show ComposeSendFailure;
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _otherPairing = 'standalone|instance:the-other-computer';

TimelineEntry _row(
  String id,
  String text,
  EntryStatus status, {
  String? code,
}) {
  final DateTime at = DateTime.utc(2026, 11, 7, 9);
  return TimelineEntry(
    id: id,
    clientId: id,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: text,
    status: status,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    failureReason: code,
    createdAt: at,
    updatedAt: at,
    spokenToInstanceId: _otherPairing,
    spokenToInstanceName: 'The other computer',
  );
}

/// A delivery still in the phone's queue, addressed to a computer this phone is
/// not connected to. The queue is one table per phone and does not filter by
/// pairing, which is why this page can answer for such a row.
OutboxItem _owedItem(String entryId, {OutboxDeliveryState state = OutboxDeliveryState.queued}) =>
    OutboxItem(
      requestId: 'req-$entryId',
      entryId: entryId,
      coveredEntryIds: <String>[entryId],
      kind: OutboxPayloadKind.text,
      source: 'manual',
      text: 'words',
      mode: 'realtime',
      createdAt: DateTime.utc(2026, 11, 7, 9),
      enqueuedAt: DateTime.utc(2026, 11, 7, 9),
      destinationMachineUid: 'machine-other',
      destinationPairingIdentity: _otherPairing,
      enqueuedPcId: 'pc-other',
      state: state,
    );

/// The exact pill on the tile that shows [rowText].
Finder _pillOn(String rowText, String pill) => find.descendant(
  of: find.ancestor(of: find.text(rowText), matching: find.byType(ChatMessageTile)),
  matching: find.text(pill),
);

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

/// A real ChatController (real outbox, real row watchdog) behind the page.
class _Rig {
  _Rig({OutboxStore? outboxStore, TimelinePersistence? rows}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = rows == null
        ? newTestStore(owner: _SessionOwner(session))
        : newTestStore(owner: _SessionOwner(session), persistence: rows);
    controller = ChatController(
      outboxStore: outboxStore ?? newTestOutboxStore(),
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

  Widget get page => MaterialApp(
    home: HistoryPage(
      store: timeline,
      storageKind: TimelineStorageKind.sqlite,
      queue: controller.outboxRowFacts,
    ),
  );

  /// Waits on both clocks: the in-memory stores settle on the real one, the
  /// session's capture shutdown on the fake one that started it.
  Future<void> dispose(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    bool disposed = false;
    unawaited(() async {
      await controller.dispose();
      await session.dispose();
      timeline.dispose();
      await transport.close();
      disposed = true;
    }());
    for (int i = 0; i < 200 && !disposed; i++) {
      await tester.pump(const Duration(seconds: 1));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    }
    expect(disposed, isTrue, reason: 'fixture: teardown finished');
  }
}

Future<void> _flush(WidgetTester tester) async {
  for (int i = 0; i < 12; i++) {
    await tester.pump();
  }
}

Future<void> _elapse(WidgetTester tester, Duration span) async {
  for (Duration t = Duration.zero; t < span; t += const Duration(seconds: 1)) {
    await tester.pump(const Duration(seconds: 1));
  }
  await _flush(tester);
}

void _tallCanvas(WidgetTester tester) {
  tester.view.physicalSize = const Size(420 * 3, 1800 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets(
    '🔴 through the real app and the history icon: a row the queue still owes says '
    'pending, a row that really failed says ✗',
    (WidgetTester tester) async {
      _tallCanvas(tester);
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();

      const String owedText = 'still being retried, nobody answered';
      const String queuedText = 'waiting its turn in the queue';
      const String lostText = 'no answer and the queue gave up on it';
      const String brokenText = 'the link broke and nothing is queued';
      const String landedText = 'this one landed';

      final InMemoryTimelinePersistence rows = InMemoryTimelinePersistence();
      await rows.upsert(_row('owed', owedText, EntryStatus.failed, code: 'INJECT_NO_RESULT'));
      await rows.upsert(_row('queued', queuedText, EntryStatus.cached));
      await rows.upsert(_row('lost', lostText, EntryStatus.failed, code: 'INJECT_NO_RESULT'));
      await rows.upsert(_row('broken', brokenText, EntryStatus.failed, code: 'LINK_DOWN'));
      await rows.upsert(_row('landed', landedText, EntryStatus.injected));

      final InMemoryOutboxStore queue = InMemoryOutboxStore();
      // Inflight on purpose: the row-watchdog window, revived to queued by the
      // boot load. Both count as owed; only `queuedText` needs `queued`.
      await queue.upsert(_owedItem('owed', state: OutboxDeliveryState.inflight));
      await queue.upsert(_owedItem('queued'));

      final AppSettingsController settings = AppSettingsController(prefs: prefs);
      await tester.pumpWidget(
        FlowMicApp(
          prefs: prefs,
          localPrefs: InMemoryLocalPrefs(),
          appSettings: settings,
          storage: TimelineStorageOpen(
            persistence: rows,
            kind: TimelineStorageKind.sqlite,
            outbox: queue,
          ),
          retainedAudio: null,
          outboxBlobDir: '${tester.binding.hashCode}/outbox_blobs_nr284',
          portableWorkDir: '${tester.binding.hashCode}/portable_nr284',
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 10));

      await tester.tap(find.byKey(const ValueKey<String>('connections.history')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();

      final AppStrings s = AppStrings.of(settings.locale);
      // Positive control: the page is up and every row is on it.
      for (final String text in <String>[owedText, queuedText, lostText, brokenText, landedText]) {
        expect(find.text(text), findsOneWidget, reason: 'row "$text" is on the page');
      }

      // The row of this card.
      expect(_pillOn(owedText, '⏳ ${s.statusNoAnswerYet}'), findsOneWidget,
          reason: 'the queue still owes this row; the chat page calls it pending');
      expect(_pillOn(owedText, '✗ ${s.statusFailed}'), findsNothing,
          reason: 'a red ✗ on a delivery nobody has given up on (NR-284)');
      // The same reason line as on the chat page, for the same event.
      expect(find.byKey(const ValueKey<String>('entry.reasonNote.owed')), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const ValueKey<String>('entry.reasonNote.owed'))).data,
        s.composeSendError(ComposeSendFailure.noResult),
      );

      // Same seam, same fix: 「queued」 and not 「delivering」.
      expect(_pillOn(queuedText, '📤 ${s.statusQueued}'), findsOneWidget);
      expect(_pillOn(queuedText, '⏳ ${s.statusDelivering}'), findsNothing,
          reason: 'no frame is on its way for a row still sitting in the queue');

      // What this card must NOT have softened: the same code with no queue item
      // behind it, and a different failure code, are final.
      expect(_pillOn(lostText, '✗ ${s.statusFailed}'), findsOneWidget);
      expect(_pillOn(brokenText, '✗ ${s.statusFailed}'), findsOneWidget);
      expect(_pillOn(landedText, '✓ ${s.statusInjected}'), findsOneWidget);
    },
  );

  testWidgets(
    '🔴 with the page open: delivering → pending, no answer → ✓ when the computer answers, '
    'with a real row watchdog and a real queue',
    (WidgetTester tester) async {
      _tallCanvas(tester);
      final AppStrings zh = AppStrings.of(AppLocale.zh); // HistoryPage's default.
      final _Rig rig = _Rig();
      await rig.controller.outbox.load();
      rig.transport.pushStatus(SocketStatus.connected);
      rig.session.noteRoomJoined(atHomeNode: true);
      await _flush(tester);

      await tester.pumpWidget(rig.page);
      unawaited(rig.controller.sendFavorite('电脑卡住了一会儿'));
      await _flush(tester);
      final List<EventEnvelope> frames = rig.transport.emitted
          .where((EventEnvelope e) => e.name == FlowMicEvents.injectRequest)
          .toList();
      expect(frames, hasLength(1), reason: 'premise: the frame left');
      expect(find.text('⏳ ${zh.statusDelivering}'), findsOneWidget);

      await _elapse(tester, const Duration(seconds: 21));
      expect(rig.timeline.entries.single.failureReason, 'INJECT_NO_RESULT',
          reason: 'premise: the row watchdog fired');
      expect(find.text('⏳ ${zh.statusNoAnswerYet}'), findsOneWidget);
      expect(find.text('✗ ${zh.statusFailed}'), findsNothing,
          reason: 'the queue is still working on this row');

      final Map<Object?, Object?> frame = frames.single.data! as Map<Object?, Object?>;
      rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': true,
        'mode': 'sendinput',
        'request_id': frame['request_id'],
        'entry_id': frame['entry_id'],
        'inject_target': <String, Object?>{
          'window_title': 'Untitled - gedit',
          'process_name': 'gedit',
          'injected_at': 'now',
        },
      });
      await _flush(tester);
      expect(find.text('✓ ${zh.statusInjected}'), findsOneWidget,
          reason: 'a late answer turns the row like any other');
      expect(find.text('⏳ ${zh.statusNoAnswerYet}'), findsNothing);

      rig.controller.session.debugStopIdlePresencePoll();
      await rig.dispose(tester);
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  testWidgets(
    '🔴 the queue moving with no row written repaints the page: ✗ before the boot load, '
    'pending after it',
    (WidgetTester tester) async {
      _tallCanvas(tester);
      final AppStrings zh = AppStrings.of(AppLocale.zh);
      final InMemoryOutboxStore queue = InMemoryOutboxStore();
      await queue.upsert(_owedItem('owed'));
      final InMemoryTimelinePersistence rows = InMemoryTimelinePersistence();
      await rows.upsert(
        _row('owed', 'said before the restart', EntryStatus.failed, code: 'INJECT_NO_RESULT'),
      );
      final _Rig rig = _Rig(outboxStore: queue, rows: rows);
      await rig.timeline.load();
      await tester.pumpWidget(rig.page);
      await tester.pump();

      // Positive control for the ✗ finder, and the honest answer at this moment:
      // the queue has not been read yet, so nothing says this row is owed.
      expect(find.text('✗ ${zh.statusFailed}'), findsOneWidget);

      await rig.controller.outbox.load();
      await _flush(tester);

      expect(find.text('⏳ ${zh.statusNoAnswerYet}'), findsOneWidget,
          reason: 'the store never fired, so only the queue can repaint this page');
      expect(find.text('✗ ${zh.statusFailed}'), findsNothing);

      rig.controller.session.debugStopIdlePresencePoll();
      await rig.dispose(tester);
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
