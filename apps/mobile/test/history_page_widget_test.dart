// V2-06b (requirement ④) — four hard requirements of the all-history page + chat page narrowed by instance.
//
// The cases that matter are the ones where the obvious implementation lies:
//   - a cloud row with no chip at all (reads as lost data) or wearing a PC name;
//   - a legacy row silently adopted into 「whoever is connected right now」;
//   - a page called 全部历史 that never mentions the 100-row persistence cap;
//   - a narrowed chat that filters by pcName and drops every noted row.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart' show TimelineStorageKind;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// Mutable owner so one store can hold rows born under several instances (and
/// under no instance at all — the legacy shape).
class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

void _seed(
  TimelineStore store,
  String clientId,
  String text, {
  Delivery delivery = Delivery.none,
  String origin = 'paired',
}) {
  store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: delivery,
    text: text,
    origin: origin,
  );
}

/// A session paired for real against the fake transport (V2-06b: the narrowed
/// chat reads connectedInstanceId, so an unpaired harness session would test
/// the empty state, not the narrowing).
Future<PttSession> _pairedSession(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-history-0000000000000000000000',
    'pc_name': '书房电脑',
    'pc_instance_id': 'inst-study',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  return session;
}

ChatController _controller(
  PttSession session,
  TimelineStore store,
  FakeSocketTransport transport,
) {
  final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
  return ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: prefs,
  );
}

void main() {
  group('all-history page', () {
    testWidgets('①②③ every row carries its attribution chip: PC name snapshot / '
        '轻记录 · 仅记录 / 未知实例', (WidgetTester tester) async {
      final _FakeOwner owner = _FakeOwner(
        'standalone|instance:pc-study',
        '书房电脑',
      );
      final TimelineStore store = newTestStore(
        deviceId: 'phone',
        owner: owner,
      );
      addTearDown(store.dispose);

      _seed(store, 'a1', '对书房说的一句');
      owner.instanceId = 'standalone|instance:pc-living';
      owner.instanceName = '客厅主机';
      _seed(store, 'b1', '对客厅说的一句');
      // A cloud row — spoken to the cloud instance, whose NAME here is the
      // server's pseudo-PC label. Hard requirement ②: the chip must read 云端实例 · 仅记录
      // and must NEVER lend the row a PC-looking name.
      owner.instanceId = 'saas|instance:cloud';
      owner.instanceName = 'FlowMic Cloud';
      _seed(store, 'c1', '云端随手记', origin: 'cloud');
      // Hard requirement ③: a legacy row with no recorded owner.
      owner.instanceId = null;
      owner.instanceName = null;
      _seed(store, 'old1', '一条没有归属的老行');

      await tester.pumpWidget(MaterialApp(
          home: HistoryPage(
            store: store,
            storageKind: TimelineStorageKind.sqlite,
          ),
        ));
      await tester.pump();

      // All four rows render — nothing hidden.
      expect(find.text('对书房说的一句'), findsOneWidget);
      expect(find.text('对客厅说的一句'), findsOneWidget);
      expect(find.text('云端随手记'), findsOneWidget);
      expect(find.text('一条没有归属的老行'), findsOneWidget);

      // The chips are ON the rows (first-class), naming the spoken-to instance.
      expect(find.text('书房电脑'), findsOneWidget);
      expect(find.text('客厅主机'), findsOneWidget);
      expect(find.text('轻记录 · 仅记录'), findsOneWidget);
      expect(find.text('未知实例'), findsOneWidget);
      // …and the cloud row was not dressed up with its pseudo-PC name.
      expect(find.text('FlowMic Cloud'), findsNothing);
    });

    testWidgets('④ the footnote reports the store that is ACTUALLY live; empty '
        'store gets an honest empty state', (WidgetTester tester) async {
      // This test used to assert 「仅保留最近 100 条」. That was the truth while the
      // whole table lived in one capped shared_preferences blob. V2-06a-2 moved
      // it to SQLite and dropped the cap, so the sentence became an outdated
      // lie — and the assertion moved with it, in the same commit.
      final TimelineStore store = newTestStore();
      addTearDown(store.dispose);

      await tester.pumpWidget(MaterialApp(
          home: HistoryPage(
            store: store,
            storageKind: TimelineStorageKind.sqlite,
          ),
        ));
      await tester.pump();

      expect(find.text(AppStrings.of(AppLocale.zh).historyAllPersisted), findsOneWidget);
      expect(find.text('还没有历史记录'), findsOneWidget);
      // The retired sentence must be gone, not merely unrendered somewhere else.
      expect(find.textContaining('仅保留最近 100 条'), findsNothing);
    });

    testWidgets('④b a FAILED upgrade says so — it never claims 全部历史都在本机', (
      WidgetTester tester,
    ) async {
      // The branch that matters. Falling back to the capped blob is survivable;
      // falling back to it while the page still promises the full history is
      // the red line (13 册 §7 F2: 不许把没做成的事说成做成了).
      final TimelineStore store = newTestStore();
      addTearDown(store.dispose);

      await tester.pumpWidget(MaterialApp(
        home: HistoryPage(
          store: store,
          storageKind: TimelineStorageKind.sharedPrefsFallback,
        ),
      ));
      await tester.pump();

      final AppStrings zh = AppStrings.of(AppLocale.zh);
      expect(find.text(zh.historyFallbackNote), findsOneWidget);
      expect(find.text(zh.historyAllPersisted), findsNothing);
      // …and it names the cap that is genuinely back in force, plus the retry —
      // otherwise the user reads a permanent design limit instead of a fault.
      expect(zh.historyFallbackNote, contains('100'));
      expect(zh.historyFallbackNote, contains('重试'));
    });

    test('the new copy is bilingual (explicit locale, never OS locale)', () {
      final AppStrings zh = AppStrings.of(AppLocale.zh);
      final AppStrings en = AppStrings.of(AppLocale.en);
      expect(zh.historyAllPersisted, isNot(equals(en.historyAllPersisted)));
      expect(zh.historyFallbackNote, isNot(equals(en.historyFallbackNote)));
      expect(en.historyFallbackNote, contains('100'));
      expect(en.historyTitle, 'All history');
      expect(en.unknownInstance, 'Unknown instance');
      expect(en.historyEmpty, 'No history yet');
    });
  });

  group('chat page narrowed by instance', () {
    testWidgets('only the CONNECTED instance\'s rows render — noted rows '
        'included; other instances and legacy rows stay out', (
      WidgetTester tester,
    ) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = await _pairedSession(transport);
      final String iid = session.connectedInstanceId!;

      final _FakeOwner owner = _FakeOwner(iid, '书房电脑');
      final TimelineStore store = newTestStore(
        deviceId: 'phone',
        owner: owner,
      );
      _seed(store, 'a1', '这条是对书房说的', delivery: Delivery.inject);
      // The load-bearing case: a noted row has no pcName and never will —
      // narrowing by pcName would drop it from the very instance it belongs to.
      _seed(store, 'a2', '这条留在手机', delivery: Delivery.none);
      owner.instanceId = 'standalone|instance:pc-living';
      owner.instanceName = '客厅主机';
      _seed(store, 'b1', '这条是对客厅说的');
      owner.instanceId = null;
      owner.instanceName = null;
      _seed(store, 'old1', '一条没有归属的老行');

      final ChatController controller = _controller(session, store, transport);
      addTearDown(() async {
        await controller.dispose();
        controller.destination.dispose();
        store.dispose();
        await session.dispose();
      });

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pump();

      expect(find.text('这条是对书房说的'), findsOneWidget);
      expect(
        find.text('这条留在手机'),
        findsOneWidget,
        reason: 'a noted row must stay in the instance view it belongs to',
      );
      expect(find.text('这条是对客厅说的'), findsNothing);
      expect(
        find.text('一条没有归属的老行'),
        findsNothing,
        reason: 'a legacy row enters no instance\'s narrowed view; it only appears on the all-history page',
      );
      // G-15①: `_pairedSession()` runs a real `pair()`, which arms the idle
      // presence-poll Timer (ptt_presence_poll.dart) — `addTearDown` above
      // disposes the session too late (AutomatedTestWidgetsFlutterBinding
      // checks for pending timers the instant the tree is torn down, before
      // teardown callbacks run). Same escape hatch send_retry_banner_test.dart
      // uses.
      session.debugStopIdlePresencePoll();
    });

    testWidgets('nothing connected → no instance\'s history is shown, and the '
        'page says so', (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );

      final _FakeOwner owner = _FakeOwner(
        'standalone|instance:pc-study',
        '书房电脑',
      );
      final TimelineStore store = newTestStore(
        deviceId: 'phone',
        owner: owner,
      );
      _seed(store, 'a1', '这条是对书房说的', delivery: Delivery.inject);

      final ChatController controller = _controller(session, store, transport);
      addTearDown(() async {
        await controller.dispose();
        controller.destination.dispose();
        store.dispose();
        await session.dispose();
      });

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pump();

      expect(find.text('这条是对书房说的'), findsNothing, reason: 'when disconnected, never bring any instance\'s history in');
      expect(find.text('未连接实例，没有可显示的历史'), findsOneWidget);
    });
  });
}
