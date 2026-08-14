// card F10 (narrowed history actually loads) + card U4 (first-run empty state).
//
// 🔴 F10 — the measured defect. `chat_flow_page` rendered
// `TimelineStore.entriesForInstance(iid)`, an IN-MEMORY FILTER over the store's
// page. That page is `loadPage(limit: 60)` with NO owner predicate, so the
// per-instance screen showed 「whichever of the globally newest 60 rows happen
// to belong to this instance」. Connect to a PC you last used yesterday and the
// conversation was empty although every row was in the table. The store's
// `loadMore()` was no help either: its only caller in the app is
// `history_page.dart`, so this list never paginated at all.
//
// 🔴 U4 — the list was built with `itemCount: 0` when there were no rows, so a
// user who had just paired faced a void between the header and the talk button.
// The test below asserts a RENDERED result, and asserts separately that 「still
// loading」does not wear the same face — telling a returning user their history
// is empty while the query is in flight is the same lie in a nicer costume.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/owner_timeline_pager.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String kThisPc = 'inst-widget'; // the ack the harness pairs with
const String kOtherPc = 'inst-other';

/// Same probe production uses (`main.dart _SessionInstanceOwner`): rows born
/// under `_NoOwner` would prove nothing, because the narrowed view correctly
/// hides them.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

/// In-memory storage that CAN answer the narrowed question.
///
/// Not a stub that returns a canned list: it implements the contract honestly
/// (owner predicate, then keyset, then limit), which is what makes a green here
/// mean something. The real SQL behind the same contract is measured against a
/// live database in `timeline_owner_page_query_test.dart`.
class _OwnerScopedMemory
    implements TimelinePersistence, OwnerScopedTimelineSource {
  final InMemoryTimelinePersistence _inner = InMemoryTimelinePersistence();
  int ownerPageCalls = 0;

  @override
  Future<List<TimelineEntry>> loadOwnerPage({
    required Set<String> ownerIds,
    DateTime? before,
    required int limit,
  }) async {
    ownerPageCalls += 1;
    if (ownerIds.isEmpty) return const <TimelineEntry>[];
    final List<TimelineEntry> all = await _inner.loadAll();
    final List<TimelineEntry> hit = all
        .where((TimelineEntry e) =>
            e.spokenToInstanceId != null &&
            ownerIds.contains(e.spokenToInstanceId) &&
            (before == null || e.createdAt.isBefore(before)))
        .toList()
      ..sort((TimelineEntry a, TimelineEntry b) =>
          b.createdAt.compareTo(a.createdAt));
    return hit.take(limit).toList(growable: false);
  }

  @override
  Future<List<TimelineEntry>> loadAll() => _inner.loadAll();
  @override
  Future<List<TimelineEntry>> loadPage({DateTime? before, required int limit}) =>
      _inner.loadPage(before: before, limit: limit);
  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 200}) =>
      _inner.search(query, limit: limit);
  @override
  Future<void> upsert(TimelineEntry entry) => _inner.upsert(entry);
  @override
  Future<void> delete(String id) => _inner.delete(id);
  @override
  Future<void> saveAll(List<TimelineEntry> entries) => _inner.saveAll(entries);
}

/// Storage whose narrowed query never answers — the 「still loading」 fixture.
class _HangingSource extends _OwnerScopedMemory {
  final Completer<List<TimelineEntry>> gate =
      Completer<List<TimelineEntry>>();

  @override
  Future<List<TimelineEntry>> loadOwnerPage({
    required Set<String> ownerIds,
    DateTime? before,
    required int limit,
  }) => gate.future;
}

TimelineEntry _row(String id, {required DateTime at, String? owner}) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: id,
      outputText: id,
      status: EntryStatus.noted,
      createdAt: at,
      updatedAt: at,
      spokenToInstanceId: owner,
      spokenToInstanceName: owner == null ? null : 'name-of-$owner',
    );

Future<PttSession> _pairedSession(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-narrow-00000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': kThisPc,
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  return session;
}

ChatController _controllerOver(
  PttSession session,
  TimelineStore store,
  FakeSocketTransport transport,
) =>
    ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );

void main() {
  final AppStrings zh = AppStrings.of(AppLocale.zh);

  group('card F10 — mergeNarrowedRows: the store and the pager are BOTH needed', () {
    final DateTime base = DateTime.utc(2026, 8, 1);
    TimelineEntry at(String id, int m) =>
        _row(id, at: base.add(Duration(minutes: m)), owner: kThisPc);

    test('older paged rows join the store\'s newest ones, newest-first', () {
      final List<TimelineEntry> merged = mergeNarrowedRows(
        <TimelineEntry>[at('new-2', 20), at('new-1', 10)],
        <TimelineEntry>[at('old-2', 5), at('old-1', 1)],
      );
      expect(
        merged.map((TimelineEntry e) => e.id).toList(),
        <String>['new-2', 'new-1', 'old-2', 'old-1'],
      );
    });

    test('a row present on both sides appears once, and the STORE copy wins',
        () {
      // The store copy carries this session's status write-backs; a duplicate
      // would also be a Flutter key collision, not a cosmetic problem.
      final TimelineEntry fresh = at('same', 10);
      final TimelineEntry stale = _row('same', at: base, owner: kThisPc);
      final List<TimelineEntry> merged =
          mergeNarrowedRows(<TimelineEntry>[fresh], <TimelineEntry>[stale]);
      expect(merged, hasLength(1));
      expect(identical(merged.single, fresh), isTrue);
    });

    test('an empty pager leaves the store list untouched', () {
      final List<TimelineEntry> live = <TimelineEntry>[at('a', 1)];
      expect(
        identical(mergeNarrowedRows(live, const <TimelineEntry>[]), live),
        isTrue,
      );
    });
  });

  group('card F10 — the narrowed view asks storage instead of filtering a page', () {
    testWidgets(
      'rows older than the globally newest 60 still appear after connecting',
      (WidgetTester tester) async {
        // FB-3 option A (owner D1, 2026-08-06) grew the composer from two rows
        // to three, so the composer got taller, and this case asserts that
        // "all five are **on screen**" — the list is lazily built, so the
        // fifth row fell out of the build window and the count became 4.
        // **That is not a change in what this case guards**: it guards
        // "my five rows were not filtered out, and the other PC's rows did
        // not leak in". So this only raises the viewport high enough to
        // hold them; the meaning of the case is unchanged word for word.
        tester.view.physicalSize = const Size(411 * 3, 1100 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = await _pairedSession(transport);
        // 🔴 Seeded with the SESSION's own identity, not the raw ack field:
        // `connectedInstanceId` is namespaced (`standalone|instance:…`), and a
        // test that stamped rows with the bare ack id would be measuring a
        // string mismatch instead of the paging defect.
        final String owner = session.connectedInstanceId!;
        final _OwnerScopedMemory storage = _OwnerScopedMemory();
        final DateTime base = DateTime.utc(2026, 8, 1);
        // Five rows spoken to THIS PC, then 80 newer rows spoken to another —
        // "the PC you last used yesterday". The unscoped newest page holds none of ours.
        for (int i = 0; i < 5; i++) {
          await storage.upsert(
            _row('mine-$i', at: base.add(Duration(minutes: i)), owner: owner),
          );
        }
        for (int i = 0; i < 80; i++) {
          await storage.upsert(
            _row('other-$i',
                at: base.add(Duration(days: 1, minutes: i)), owner: kOtherPc),
          );
        }

        final TimelineStore store = newTestStore(
          persistence: storage,
          owner: _SessionOwner(session),
        );
        final ChatController controller =
            _controllerOver(session, store, transport);
        addTearDown(() async {
          await controller.dispose();
          controller.destination.dispose();
          store.dispose();
          await session.dispose();
        });

        // The store loads its page exactly as production does: global, 60 rows,
        // no owner predicate.
        await store.load();
        // [unit] the defect, measured before the widget is even built.
        expect(
          store.entriesForInstance(owner),
          isEmpty,
          reason: 'baseline: the in-memory filter this card replaced sees '
              'nothing, because the global newest page is all other-PC rows',
        );

        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(
            home: ChatFlowPage(controller: controller, historySource: storage),
          ),
        );
        await tester.pump();
        await tester.pump();

        // 🔴 The assertion the card exists for: the conversation is on screen.
        expect(find.byType(ChatMessageTile), findsNWidgets(5));
        for (int i = 0; i < 5; i++) {
          expect(find.text('mine-$i'), findsOneWidget);
        }
        // …and requirement ④ still holds: the other PC's rows did not leak in.
        expect(find.text('other-79'), findsNothing);
        expect(storage.ownerPageCalls, greaterThan(0),
            reason: 'the page must come from a QUERY, not from a filter');

        session.debugStopIdlePresencePoll();
      },
    );

    testWidgets(
      'scrolling to the upper edge loads an older page',
      (WidgetTester tester) async {
        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = await _pairedSession(transport);
        final String owner = session.connectedInstanceId!;
        final _OwnerScopedMemory storage = _OwnerScopedMemory();
        final DateTime base = DateTime.utc(2026, 8, 1);
        // 90 owned rows: more than one page (60), so the second page only ever
        // arrives if the upper edge actually triggers. Before this card the
        // chat page had NO paging trigger at all.
        for (int i = 0; i < 90; i++) {
          await storage.upsert(
            _row('row-$i', at: base.add(Duration(minutes: i)), owner: owner),
          );
        }

        final TimelineStore store = newTestStore(
          persistence: storage,
          owner: _SessionOwner(session),
        );
        final ChatController controller =
            _controllerOver(session, store, transport);
        addTearDown(() async {
          await controller.dispose();
          controller.destination.dispose();
          store.dispose();
          await session.dispose();
        });

        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(
            home: ChatFlowPage(controller: controller, historySource: storage),
          ),
        );
        await tester.pump();
        await tester.pump();
        final int afterFirstPage = storage.ownerPageCalls;
        expect(afterFirstPage, 1);

        // The oldest row of the FIRST page is row-30 (90 rows, newest 60).
        // row-0 can only exist on screen if a second page was fetched.
        final Finder list = find.byKey(const ValueKey<String>('chat.timeline'));
        expect(list, findsOneWidget);
        // reverse:true ⇒ older is UP ⇒ drag downward moves toward maxScrollExtent.
        for (int i = 0; i < 40; i++) {
          await tester.drag(list, const Offset(0, 600));
          await tester.pump();
        }
        await tester.pump();

        expect(storage.ownerPageCalls, greaterThan(afterFirstPage),
            reason: 'the upper edge must ask for an older page');
        expect(find.text('row-0'), findsOneWidget,
            reason: 'the oldest owned row is reachable by scrolling');

        session.debugStopIdlePresencePoll();
      },
    );
  });

  group('card U4 — the first screen after pairing is not a void', () {
    testWidgets(
      'no rows yet renders the empty state, not an empty list',
      (WidgetTester tester) async {
        final _OwnerScopedMemory storage = _OwnerScopedMemory();
        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = await _pairedSession(transport);
        final TimelineStore store = newTestStore(
          persistence: storage,
          owner: _SessionOwner(session),
        );
        final ChatController controller =
            _controllerOver(session, store, transport);
        addTearDown(() async {
          await controller.dispose();
          controller.destination.dispose();
          store.dispose();
          await session.dispose();
        });

        await store.load();
        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(
            home: ChatFlowPage(controller: controller, historySource: storage),
          ),
        );
        await tester.pump();
        await tester.pump();

        // 🔴 Rendered result, not a widget-tree shape: the user must SEE words.
        expect(
          find.byKey(const ValueKey<String>('chat.timeline.empty')),
          findsOneWidget,
        );
        expect(find.text(zh.historyEmpty), findsOneWidget);
        // The old face: a list with nothing in it.
        expect(find.byType(ChatMessageTile), findsNothing);
        expect(
          find.byKey(const ValueKey<String>('chat.timeline.loading')),
          findsNothing,
          reason: '"none" must not be dressed as "still loading"',
        );

        session.debugStopIdlePresencePoll();
      },
    );

    testWidgets(
      'still loading does NOT wear the empty state face',
      (WidgetTester tester) async {
        final _HangingSource storage = _HangingSource();
        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = await _pairedSession(transport);
        final TimelineStore store = newTestStore(
          persistence: storage,
          owner: _SessionOwner(session),
        );
        final ChatController controller =
            _controllerOver(session, store, transport);
        addTearDown(() async {
          await controller.dispose();
          controller.destination.dispose();
          store.dispose();
          await session.dispose();
        });

        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(
            home: ChatFlowPage(controller: controller, historySource: storage),
          ),
        );
        await tester.pump();

        // 🔴 A returning user whose page is in flight must NOT be told their
        // history is empty — that reads as "the records are gone".
        expect(
          find.byKey(const ValueKey<String>('chat.timeline.loading')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey<String>('chat.timeline.empty')),
          findsNothing,
        );
        // And the spinner is not a bare void: it says what it is doing.
        expect(find.text(zh.historyLoadingMore), findsOneWidget);

        // It also RESOLVES — a spinner that never clears is the same defect.
        storage.gate.complete(const <TimelineEntry>[]);
        await tester.pump();
        await tester.pump();
        expect(
          find.byKey(const ValueKey<String>('chat.timeline.empty')),
          findsOneWidget,
        );

        session.debugStopIdlePresencePoll();
      },
    );
  });
}
