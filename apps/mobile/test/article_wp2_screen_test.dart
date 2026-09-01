// Work package 2, card 4 — the article-surface tests that were never
// written: A-1 (restart persistence), A-2 (pagination boundary), A-4 (the
// article header does not enter multi-select). A-3 (catch-up transcription)
// and A-5 (nine-locale rendering) live in their own files — see
// article_catchup_screen_test.dart and article_locales_screen_test.dart for
// why each needed a different rig.
//
// ── ⚠️ SAME LAW AS article_screen_test.dart, NOT REPEATED IN FULL HERE ──────
// Read that file's header first. Two rules it established are load-bearing
// below too:
//   · production chains run inside `tester.runAsync`, or a real timer's
//     `await` never returns;
//   · `findsNothing` over a lazy `ListView` is not evidence of absence —
//     an unbuilt child is invisible to every finder.
// A-2 below hits the SECOND one at real production scale (a 60-row keyset
// page), not the toy scale the other article tests use.
//
// 🔴 EVERY CASE MOUNTS THE REAL SCREEN (`ChatFlowPage` → `entriesForOwners`),
// never `ArticlePage` and never the model directly — that distinction is
// card 4 itself (CR-7/CR-8 shipped broken in 0.3.47 while a model test and an
// `ArticlePage` test were both honestly green; see article_screen_test.dart's
// header for the full account).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';
import 'support/di.dart';
import 'support/fakes.dart';

Future<void> _mount(WidgetTester tester, ArticleRig r) =>
    mountLightRecordScreen(tester, r);

void main() {
  // ══ A-1 — after an app restart, a long recording is still one card ═══════
  group('A-1: app-restart persistence', () {
    testWidgets(
        '🔴 A-1: a finished recording survives a full app restart as ONE '
        'card, not four rows', (WidgetTester tester) async {
      final TimelinePersistence disk = InMemoryTimelinePersistence();

      // ── "session one": record, then the process is torn down ────────────
      final ArticleRig before = ArticleRig(persistence: disk);
      await tester.runAsync(before.recordThreeAndStop);
      // 🔴 MOUNTING IS NOT COSMETIC HERE: `ChatController`'s utterance-settle
      // chain does not fully land off `pumpEventQueue()` alone — it needs a
      // real widget-tree pump to drain (measured while writing this case:
      // `store.entries` read straight after `runAsync(recordThreeAndStop)`,
      // before mounting anything, was still `0`). Every other article test
      // mounts before it ever inspects the result for exactly this reason;
      // this is the first one that needed to say so, because it is the first
      // one that ALSO needs to inspect state before mounting the "after" side.
      await _mount(tester, before);
      // `TimelineStore._persistOne` is fire-and-forget (unawaited) — one more
      // beat so its microtask chain actually reaches `disk` before the rig
      // (and the "process") goes away.
      await tester.runAsync(pumpEventQueue);
      // `dispose()` runs `PttSession`'s real teardown chain (cancels its
      // presence-poll timer among other things) — production code, so it
      // runs under `runAsync` too, not the widget-test's fake-time zone.
      await tester.runAsync(before.dispose);

      // ── "session two": a FRESH store/session/controller, same disk ──────
      final ArticleRig after = ArticleRig(persistence: disk);
      addTearDown(after.dispose);
      // The production edge this line stands in for is `main.dart:500`
      // (`_store.load()` on startup): removing this call reproduces "the app
      // never re-reads what it persisted" and reliably turns this case red
      // — verified, verbatim red pasted in the card report.
      await after.store.load();
      await _mount(tester, after);

      expect(find.byType(ChatArticleTile), findsOneWidget,
          reason: 'one recording was persisted; restart must not turn it '
              'into zero cards or into more than one');
      expect(find.byType(ChatMessageTile), findsNothing,
          reason: 'the three segments must not reappear as loose rows after '
              'a reload — that is the exact defect this card guards '
              '(CR-7/CR-8, 0.3.47)');

      // The card is not a husk: it still opens to the real words.
      await tester.tap(find.byType(ChatArticleTile));
      await tester.pumpAndSettle();
      expect(find.byType(ArticlePage), findsOneWidget);
      expect(find.textContaining('两件事'), findsWidgets);
      expect(find.textContaining('库存口径'), findsWidgets);
      expect(find.textContaining('采购节奏'), findsWidgets);
    });
  });

  // ══ A-2 — pagination boundary: a recording spanning a page edge ══════════
  group('A-2: pagination boundary', () {
    testWidgets(
        '🔴 A-2: when the head falls off the loaded page, a loaded member '
        'stays a row instead of vanishing', (WidgetTester tester) async {
      // Card F10's page is `TimelineStore.pageSize` = 60, keyset-paged on
      // `created_at DESC` with a STRICT cursor (timeline_store.dart:204-231).
      // The head is always the OLDEST row of its own article (it is minted
      // at `beginContinuous()`, before any member settles), so the boundary
      // this card names is real: put ≥60 rows newer than the head, and the
      // head falls off page 1 while a member spoken right after it can stay
      // on.
      //
      // This is deliberately NOT the pure-function case in
      // article_view_test.dart ("a member whose head is not in the window
      // stays a row") — that one hands `collapseArticles` a hand-built list.
      // Here the WINDOW ITSELF is produced by a real keyset page over real
      // persistence, through the real screen.
      final TimelinePersistence disk = InMemoryTimelinePersistence();

      // A real, paired session purely to get the SAME `connectedInstanceId`
      // the screen will read at render time — every row below is stamped
      // with it directly (bypassing `buildFromUtterance`, since this case
      // needs exact control over `createdAt` to place the page boundary).
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
        stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      );
      addTearDown(session.dispose);
      giveSessionAPairedIdentity(session);
      final String owner = session.connectedInstanceId!;

      const String articleId = 'a0-wp2boundary';
      final DateTime t0 = DateTime.utc(2026, 9, 1, 9);
      final TimelineEntry head = TimelineEntry(
        id: 'loc_$articleId',
        clientId: articleId,
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        sourceText: null,
        outputText: '会议记录',
        status: EntryStatus.noted,
        entryType: TimelineEntry.kArticle,
        articleId: articleId,
        origin: 'cloud',
        durationMs: 30000,
        segmentsCount: 1,
        spokenToInstanceId: owner,
        createdAt: t0,
        updatedAt: t0,
      );
      final TimelineEntry member = TimelineEntry(
        id: 'm-boundary-1',
        clientId: 'm-boundary-1',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        sourceText: '跨页那一段',
        outputText: '跨页那一段',
        status: EntryStatus.noted,
        origin: 'cloud',
        articleId: articleId,
        articleOffsetMs: 0,
        durationMs: 30000,
        spokenToInstanceId: owner,
        createdAt: t0.add(const Duration(seconds: 1)),
        updatedAt: t0.add(const Duration(seconds: 1)),
      );
      // 59 filler rows, all newer than [member] — together with [member]
      // that is exactly 60, i.e. exactly `TimelineStore.pageSize`, so the
      // FIRST page holds precisely [59 fillers + member] and excludes
      // [head] (the 61st-newest row).
      final List<TimelineEntry> fillers = List<TimelineEntry>.generate(
        59,
        (int i) {
          final DateTime at = t0.add(Duration(seconds: 2 + i));
          return TimelineEntry(
            id: 'filler-$i',
            clientId: 'filler-$i',
            mode: FlowMode.realtime,
            delivery: Delivery.none,
            sourceText: '闲聊 $i',
            outputText: '闲聊 $i',
            status: EntryStatus.noted,
            origin: 'cloud',
            spokenToInstanceId: owner,
            createdAt: at,
            updatedAt: at,
          );
        },
      );
      await disk.saveAll(<TimelineEntry>[head, member, ...fillers]);

      final TimelineStore store = newTestStore(persistence: disk);
      addTearDown(store.dispose);
      await store.load();

      // Positive control on the SETUP itself, before mounting anything: the
      // page really did split where this case's argument says it does.
      expect(store.entries, hasLength(60),
          reason: 'setup error: the store did not load exactly one page');
      expect(store.entries.any((TimelineEntry e) => e.id == head.id), isFalse,
          reason: 'setup error: the head must be the one row NOT on page 1');
      expect(store.entries.any((TimelineEntry e) => e.id == member.id), isTrue,
          reason: 'setup error: the member must be ON page 1');

      final ChatController controller = ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: store,
        destination: DestinationController(fixedRecordOnly: true),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(),
      );
      addTearDown(controller.dispose);
      transport.pushStatus(SocketStatus.connected);

      // Tall enough to build every one of the 60 loaded rows — the
      // "raise the canvas" half of the article_screen_test.dart gotcha, at
      // the scale this card actually needs it at.
      tester.view.physicalSize = const Size(800, 20000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      // 🔴 The primary claim. The head is not loaded ⇒ no card exists for
      // this article yet — a screen that invented one from a member alone
      // would be showing a recording nobody can currently open.
      expect(find.byType(ChatArticleTile), findsNothing,
          reason: 'the head is on the next page up; there must be no card '
              'for an article whose cover this screen has not loaded');
      // 🔴 The claim this card exists for. `collapseArticles`'s rule ("a
      // member whose head is not in the window stays a row") must hold
      // through the REAL keyset page, not just the pure function.
      expect(find.text('跨页那一段'), findsOneWidget,
          reason: 'a loaded member must not vanish just because its head '
              'has not loaded yet — that would take the user\'s words off '
              'the screen with nothing to open in their place');
      // It still carries its position inside the (still out of reach)
      // recording — the `ArticleRowStamp` wrapper, same as C-1.
      expect(find.byType(ArticleRowStamp), findsOneWidget);
    });
  });

  // ══ A-4 — the article header does not enter multi-select ═════════════════
  group('A-4: the article header and multi-select', () {
    testWidgets(
        '🔴 A-4: with selection mode active, tapping the article card still '
        'opens the piece — it never grows a checkbox', (WidgetTester tester) async {
      final ArticleRig r = ArticleRig();
      addTearDown(r.dispose);
      await tester.runAsync(r.recordThreeAndStop);
      await _mount(tester, r);

      // An ordinary utterance too, so selection mode can be entered from a
      // row that genuinely supports it (`ChatMessageTile.onSelectToggle`) —
      // entering via the article head's OWN long-press menu would also be a
      // fair way in (`entry_context_menu.dart` offers "multi-select" on
      // every row without exception), but starting from an ordinary row
      // keeps this case's positive control (the ordinary row DOES grow a
      // checkbox) and its subject (the article card) clearly apart.
      //
      // 🔴 Driven AFTER the first mount/pump, not folded into the same
      // `runAsync` block as `recordThreeAndStop` above: measured while
      // writing this case — the settle chain needs a real widget pump to
      // drain (`SchedulerBinding` work does not advance on `pumpEventQueue()`
      // alone under `AutomatedTestWidgetsFlutterBinding`), and stacking a
      // second unsettled utterance behind the first before ever pumping lost
      // the card outright (`find.byType(ChatArticleTile)` went to `findsNothing`
      // right after mounting).
      await tester.runAsync(() async {
        await r.controller.pttDown();
        await r.controller.pttUp();
        await r.say('随手记一句', 3, isSegment: false);
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(ChatArticleTile), findsOneWidget);
      final Finder ordinaryRow = find.text('随手记一句');
      expect(ordinaryRow, findsOneWidget, reason: 'setup error');

      // Enter selection mode the one documented way: long-press an ordinary
      // row, then choose "multi-select" from its context menu.
      await tester.longPress(ordinaryRow);
      await tester.pumpAndSettle();
      final AppStrings strings = AppStrings(AppLocale.zh);
      final Finder selectMenuItem = find.text(strings.selectionEnter);
      expect(selectMenuItem, findsOneWidget,
          reason: 'setup error: the multi-select menu item is not on screen');
      await tester.tap(selectMenuItem);
      await tester.pumpAndSettle();

      // Positive control: selection mode really is on, and an ordinary row
      // really does grow a checkbox in it (chat_message_tile.dart's
      // `entry.select.on/off.<id>`).
      expect(find.text('☑'), findsOneWidget,
          reason: 'setup error: selection mode did not seed/tick the row '
              'the user long-pressed');

      // 🔴 THE CLAIM. The article card carries no `onSelectToggle` /
      // `selected` parameters at all (chat_article_tile.dart:43-49) — its
      // tap is `onOpen`, unconditionally, in every mode. So tapping it here
      // must still open the piece, exactly as it would outside selection
      // mode — never a silent toggle with nothing to show for it, and never
      // a tap that does nothing.
      await tester.tap(find.byType(ChatArticleTile));
      await tester.pumpAndSettle();
      expect(find.byType(ArticlePage), findsOneWidget,
          reason: '🔴 the article header must not be swallowed by multi-'
              'select — a tap on it keeps meaning "open this recording", '
              'in every mode, because it has no other behaviour to switch to');
    });
  });
}
