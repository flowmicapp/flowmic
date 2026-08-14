// Card FB-7 —— 🔴 **wiring** test: prove the production path is actually
// hung up, not merely "defined".
//
// Provenance (why this test is not optional): the reverse control in
// `data_flow_disclosure_test.dart` caught this — when you only assert
// "imported / class exists / key exists", deleting the render line leaves
// **the whole file still fully green**, while the screen shows nothing
// (13 册 §7 F1 ①: a lost call site leaves no new symbol to grep).
// 0.2.51 hit the same shape again: tracker unit tests all green while the
// production entry was unwired.
// ⇒ This file walks the **real page** throughout: long-press → menu →
//   「多选」→ toolbar → tap a row → button, every step a real tap.
//
// ⚠️ This window has **no real device**. Everything below is
// "unit-test proven + real-device unproven".
//
// ⚠️ The clipboard case uses the **real** `Clipboard.setData` (the
// production default), only swapping the platform channel for a fake to
// catch it — not opening a test-only injection port in production code.
//
// ── 🔴 Two reverse controls (each stands for a **class** of error, not
// a single line of code) ────────────────────────────────
// One reverse control can only prove "changing THIS spot gets caught".
// To show a **class** of error is guarded, that change must be a
// **representative** of the class. So there are two, one of each kind:
//
// RC1 —— **"defined but not hung up"** (13 册 §7 F1 ①: a lost call
//   site leaves no new symbol to grep).
//   Change: in `chat_flow_page.dart` build, replace
//   `if (_selection.active) _selectionBarRouted(...)` with `if (false)`.
//   measured: `selection_state_test` + `selection_batch_actions_test` +
//   `selection_bar_render_test` **35 cases all green** (they are
//   structurally blind to "is it hung up"), while this file went red
//   immediately:
//     Expected: exactly one matching candidate
//       Actual: _KeyWidgetFinder:<Found 0 widgets with key [<'selection.bar'>]: []>
//        Which: means none were found but one was expected
//   Restored, marker grep = 0, re-greened.
//
// RC2 —— **"content-safety gate stripped"** (this card's only path that
//   can eat user content).
//   Change: delete from `checkBatchOrganize`
//   `if (buffer.trim().isNotEmpty) return BatchOrganizeRefusal.bufferBusy;`.
//   measured red, verbatim:
//     Expected: '输入框里还有没发出的文字，会被覆盖 · 请先发出或清空'
//       Actual: '已把 1 条记录放进输入框，正在交 AI 整理'
//   🔴 Note the Actual sentence —— the user's unsent words have already
//   been overwritten, and the UI is reporting success. That is the
//   entire reason this gate exists. Restored, marker grep = 0, re-greened.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart'
    show AiComposeDone;
import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, AppSettingsController;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart' show SessionState;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
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

const AppStrings _zh = AppStringsZh();
const String kThisPc = 'inst-widget';

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

TimelineEntry _row(String id, String body, {int minute = 0, bool image = false}) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      sourceText: image ? null : body,
      outputText: body,
      status: EntryStatus.injected,
      entryType: image ? TimelineEntry.kImage : TimelineEntry.kTranscript,
      createdAt: DateTime.utc(2026, 8, 7).add(Duration(minutes: minute)),
      updatedAt: DateTime.utc(2026, 8, 7).add(Duration(minutes: minute)),
      // 🔴 Ownership id is back-filled by [_pump] after pairing:
      // `connectedInstanceId` is **namespaced** (measured
      // `standalone|instance:inst-widget`), not the bare string in the ack.
      // Hard-coding the bare string would make every row not belong to this
      // screen, and the page would honestly render the empty state — then
      // this wiring test would go red "because no rows are visible" in the
      // wrong place.
      spokenToInstanceName: 'Widget PC',
    );

class _Harness {
  _Harness(this.transport, this.controller, this.store);
  final FakeSocketTransport transport;
  final ChatController controller;
  final TimelineStore store;

  /// compose:start frames the page really put on the wire.
  List<Map<String, Object?>> get composeFrames => transport.emitted
      .where((EventEnvelope e) => e.name == 'compose:start')
      .map((EventEnvelope e) => (e.data ?? const <String, Object?>{}) as Map<String, Object?>)
      .toList();
}

/// The page's locale comes from an [AppSettingsController], exactly as
/// `main.dart` supplies it (`ChatFlowPage.appSettings` → `_strings`). The
/// four-language test below therefore renders through the SAME path the product
/// uses; it does not build an `AppStrings.of(loc)` of its own and compare a
/// string to itself.
Future<AppSettingsController> _settingsAt(AppLocale locale) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController s = AppSettingsController(prefs: prefs);
  await s.load();
  s.setLocale(locale);
  return s;
}

Future<_Harness> _pump(
  WidgetTester tester, {
  required List<TimelineEntry> rows,
  AppLocale? locale,
}) async {
  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-select-00000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': kThisPc,
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');

  final InMemoryTimelinePersistence storage = InMemoryTimelinePersistence();
  final String owner = session.connectedInstanceId!;
  for (final TimelineEntry e in rows) {
    await storage.upsert(e.copyWith(spokenToInstanceId: owner));
  }
  final TimelineStore store = newTestStore(
    persistence: storage,
    owner: _SessionOwner(session),
  );
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    store.dispose();
    await session.dispose();
  });
  await store.load();
  // PA-1…PA-4 (Plan A′): the dock grew (key group + captions), and on the
  // default 800×600 surface the timeline kept ~90px — the ListView then
  // virtualized the second seeded row off the tree and every row-targeting
  // finder went red for a reason that is geometry, not wiring. A phone-tall
  // surface restores the harness's premise (real devices are 780+ tall).
  tester.view.physicalSize = const Size(800 * 3, 900 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  transport.pushStatus(SocketStatus.connected);
  final AppSettingsController? appSettings =
      locale == null ? null : await _settingsAt(locale);
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(controller: controller, appSettings: appSettings),
    ),
  );
  await tester.pump();
  await tester.pump();
  session.debugStopIdlePresencePoll();
  return _Harness(transport, controller, store);
}

/// 🔴 **Do not use `pumpAndSettle` here** — this is measured, not style.
/// Once organize is running the AI action row draws a spinner
/// (`ai_action_row.dart`'s busy pill), which is a **never-stopping
/// animation** ⇒ `pumpAndSettle` keeps advancing the fake clock until
/// `AiComposeController`'s 45-second watchdog actually fires and aborts
/// the run — only then does it "settle" and return normally. The first
/// run went red exactly that way: `isAiComposing` was false, the
/// SnackBar had already been taken down by its 2-second timer, and the
/// three assertions looked like the feature was broken.
/// ⇒ Pump two frames, bounded: enough for the SnackBar to enter the
/// tree and for one repaint, not enough to reach the watchdog.
Future<void> _settleShort(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

/// Quiesce everything the body may have left ticking, before it returns.
///
/// 🔴 Not hygiene — `flutter_test` asserts `!timersPending` at the END OF THE
/// BODY, i.e. BEFORE any `addTearDown` runs, and `AiComposeController`'s 45 s
/// watchdog is NOT in the widget tree, so tearing the tree down does not cancel
/// it (a SnackBar's own 2 s timer IS in the tree, which is why the refusal tests
/// never needed this). Measured: without it the two success tests fail with
/// "A Timer is still pending even after the widget tree was disposed" — a
/// failure that says nothing about the feature.
Future<void> _endRun(WidgetTester tester, _Harness h) async {
  // Answer the run the way the SERVER would, rather than aborting it. An abort
  // raises a failure, a failure raises a banner, and an event-type banner arms
  // its OWN auto-hide Timer (chat_transient_banner_timers.dart) — so aborting
  // trades one pending timer for another. Measured, both ways.
  final Map<String, Object?>? frame =
      h.composeFrames.isEmpty ? null : h.composeFrames.last;
  if (frame != null) {
    h.controller.aiCompose.onEvent(
      AiComposeDone(
        outputText: 'organised',
        requestId: frame['request_id'] as String?,
      ),
    );
  }
  // Long enough for the SnackBar's own 2 s timer to fire and its exit animation
  // to finish; short enough never to reach the 45 s watchdog.
  await tester.pump(const Duration(seconds: 3));
  await tester.pump(const Duration(milliseconds: 400));
  // LAST, not first: the idle presence poll re-arms itself, so stopping it
  // before the pumps above just lets it come back.
  h.controller.session.debugStopIdlePresencePoll();
}

/// Find an AI action pill by the key it carries, not by the word it prints.
///
/// 🔴 WHY A KEY AND NOT `find.text(aiTaskLabel(task))` — and why this is NOT a
/// retreat from "assertions must land on the rendered result" (0.2.53,
/// `inject_verdict_note_test`).
/// FB-3 (`060c225`, owner ruling D1/D2/D4 of 2026-08-06) rebuilt the composer as
/// three rows, and the AI pills lost their text labels: four 38px keyed buttons
/// became one 60px chip carrying Icon + Tooltip + Semantics. So the label these
/// two call sites typed is no longer on screen, and `find.text` correctly found
/// nothing — the tests went red because they were doing their job.
///
/// The distinction that decides the fix: these two lines are not ASSERTING the
/// label, they are OPERATING the control on the way to an assertion about
/// something else ("did this refusal sentence appear on screen"). The
/// rendered-output rule governs what a test CLAIMS a user can read; it does
/// not require that every tap be aimed at a word. Aiming a tap at a word is
/// in fact the fragile part: it couples an unrelated assertion to a copy
/// decision, which is exactly how one UI ruling reddened five tests that have
/// nothing to say about labels.
/// The four-language assertions below still land on rendered text, unchanged.
///
/// ⚠️ REVERSIBILITY, WRITTEN DOWN ON PURPOSE: owner has been asked to look at the
/// icon-only pills in person (decision batch #10 — the demo that was approved
/// drew four remote keys as a single chip and therefore understated how crowded
/// the row would be). **If owner rules the text labels back, this helper is the
/// one place to revisit**: a keyed finder keeps passing whether or not the label
/// returns, so nothing here will fail to tell you the label came back. That is a
/// deliberate trade — these five tests are about refusal copy, and a separate
/// test should own "the pill prints its name" if that becomes a promise again.
/// → That ruling landed 2026-08-11 (#4): labels ARE back (labelled-preferred,
/// inside the edit card), and "the pill prints its name" is owned by
/// compose_three_row_layout_test.dart's boundary case — this keyed finder kept
/// passing across the move, exactly as the paragraph above predicted.
Finder _aiTaskFinder(ComposeTask task) =>
    find.byKey(ValueKey<String>('ai.task.${task.wire}'));

/// Walk the REAL entry path into selection mode: long-press a row, tap 「多选」.
///
/// ⚠️ `strings` is the page's CURRENT locale, not always zh — the four-language
/// tests render the page in ja/ko too, and the menu item is translated.
Future<void> _enterSelection(
  WidgetTester tester,
  String rowText, {
  AppStrings strings = _zh,
}) async {
  await tester.longPress(find.text(rowText));
  await tester.pumpAndSettle();
  expect(
    find.text(strings.selectionEnter),
    findsOneWidget,
    reason: 'the long-press menu has no 「多选」 ⇒ the entry does not exist at all',
  );
  await tester.tap(find.text(strings.selectionEnter));
  await tester.pumpAndSettle();
}

/// Put the session where "an utterance is in flight" is true, through the PRODUCTION FSM.
///
/// 🔴 WHY THE AUDIO STACK IS NOT ENTERED, measured rather than assumed. The
/// first version of these tests held the real `PttBar`
/// (`tester.startGesture` → `onLongPressStart` → `ChatController.pttDown`).
/// It works — and then `_pump`'s `addTearDown(() async { … await
/// session.dispose(); })` never returns: teardown awaits `audio.stop()` →
/// `await _pcmSub.cancel()`, a future created inside `testWidgets`' FakeAsync
/// zone that nothing will ever advance. **Measured**: the recording case hung
/// for the full 10-minute test timeout and wedged the NEXT test with
/// `Failed assertion: '!inTest'`. `recording_panel_widget_test.dart` states the
/// same boundary verbatim (「the session's own teardown is async plumbing this
/// widget test deliberately does not enter」) and enters RECORDING exactly this
/// way, and `mic_permission_denial_widget_test.dart`'s `_swipeUpCancel` records
/// the release half of the same deadlock.
///
/// What is NOT weakened by this: `_sess` is a mirror of `session.fsm.session`
/// (`chat_outbox_host.dart:322`), `isRecording` / `sessionState` read it, and
/// `chat_flow_selection.dart` reads THOSE. Every layer this card is about is
/// the production one. What is skipped is capture plumbing, which is pinned by
/// `mic_permission_denial_widget_test.dart` and `chat_controller_test.dart`.
Future<void> _enterRecording(WidgetTester tester, _Harness h) async {
  h.controller.session.fsm.onPttDown();
  await tester.pump();
  expect(
    h.controller.isRecording,
    isTrue,
    reason: 'positive control: if we never actually entered recording, the rest measures air',
  );
}

/// The SnackBar the page just raised, by its rendered text.
String _lastToast(WidgetTester tester) {
  final Finder bar = find.byType(SnackBar);
  expect(bar, findsOneWidget, reason: 'no toast at all ⇒ a silent no-op');
  return tester.widget<Text>(find.descendant(of: bar, matching: find.byType(Text))).data!;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('① the entry is actually hung up (anti-façade)', () {
    testWidgets('long-press → 「多选」 → the toolbar appears, and the long-pressed row is already checked',
        (WidgetTester tester) async {
      await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
        _row('b', '第二句', minute: 2),
      ]);
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsNothing);

      await _enterSelection(tester, '第一句');

      expect(
        find.byKey(const ValueKey<String>('selection.bar')),
        findsOneWidget,
        reason: '🔴 when the menu item exists but the page is unwired, this is the only assertion that goes red',
      );
      // Seed: the long-pressed row is the selected row.
      expect(find.byKey(const ValueKey<String>('entry.select.on.a')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('entry.select.off.b')), findsOneWidget);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey<String>('selection.count')))
            .data,
        _zh.selectionCount(1),
      );
    });

    testWidgets('single-tap toggle: check the second row, tap again to uncheck', (WidgetTester tester) async {
      await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
        _row('b', '第二句', minute: 2),
      ]);
      await _enterSelection(tester, '第一句');

      await tester.tap(find.text('第二句'));
      await tester.pump();
      expect(find.byKey(const ValueKey<String>('entry.select.on.b')), findsOneWidget);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey<String>('selection.count')))
            .data,
        _zh.selectionCount(2),
      );

      await tester.tap(find.text('第二句'));
      await tester.pump();
      expect(find.byKey(const ValueKey<String>('entry.select.off.b')), findsOneWidget);
    });

    testWidgets('🔴 in multi-select, long-press no longer opens the menu, and double-tap no longer zooms', (WidgetTester tester) async {
      // This pins what `ChatMessageTile` itself **cannot police** (a tile
      // policing the host's argument list is a comment asserting behaviour
      // elsewhere = anti-façade ④), so the test pins it.
      await _pump(tester, rows: <TimelineEntry>[_row('a', '第一句', minute: 1)]);
      await _enterSelection(tester, '第一句');

      final ChatMessageTile tile =
          tester.widget<ChatMessageTile>(find.byType(ChatMessageTile).first);
      expect(tile.onSelectToggle, isNotNull);
      expect(tile.onLongPress, isNull, reason: 'long-press still opens the menu ⇒ checking a row pops the single-row actions');
      expect(tile.onZoom, isNull, reason: 'double-tap still goes fullscreen ⇒ it eats "tap twice to check then uncheck"');

      await tester.longPress(find.text('第一句'));
      await tester.pumpAndSettle();
      expect(find.text(_zh.confirmDelete), findsNothing, reason: 'the menu must not appear');
    });

    testWidgets('✕ leaves multi-select, and long-press returns to the original menu', (WidgetTester tester) async {
      await _pump(tester, rows: <TimelineEntry>[_row('a', '第一句', minute: 1)]);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.byKey(const ValueKey<String>('selection.cancel')));
      await tester.pump();
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsNothing);
      expect(find.byKey(const ValueKey<String>('entry.select.on.a')), findsNothing);

      await tester.longPress(find.text('第一句'));
      await tester.pumpAndSettle();
      expect(find.text(_zh.selectionEnter), findsOneWidget);
    });
  });

  group('② batch copy: what lands on the clipboard = what the sentence says', () {
    late List<String> clipboard;

    setUp(() {
      clipboard = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (
        MethodCall call,
      ) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add((call.arguments as Map<Object?, Object?>)['text'] as String);
        }
        return null;
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    testWidgets('🔴 two text rows: the clipboard string and the toast count are the same fact',
        (WidgetTester tester) async {
      await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
        _row('b', '第二句', minute: 2),
      ]);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第二句'));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.copy')));
      await tester.pumpAndSettle();

      expect(clipboard, hasLength(1), reason: 'it really went through the system clipboard');
      // One **joint** assertion: the number in the sentence is computed from
      // the clipboard contents, not two independently-true assertions.
      final List<String> landed = clipboard.single.split('\n');
      expect(landed, <String>['第二句', '第一句'], reason: 'the list is reverse-chronological, and copy follows it');
      expect(_lastToast(tester), _zh.selectionCopiedRecords(landed.length));
      // After a successful copy, leave multi-select.
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsNothing);
    });

    testWidgets('🔴 mixed selection: the image is not taken, and it is counted in the same sentence',
        (WidgetTester tester) async {
      await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
        _row('i', '🖼 PNG · 214 KB', minute: 2, image: true),
      ]);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('🖼 PNG · 214 KB'));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.copy')));
      await tester.pumpAndSettle();

      expect(clipboard.single, '第一句');
      expect(
        clipboard.single.contains('PNG'),
        isFalse,
        reason: 'the descriptor must never impersonate record content',
      );
      expect(
        _lastToast(tester),
        _zh.selectionCopiedRecordsSkippedImages(1, 1),
      );
    });

    testWidgets('🔴 all images: the clipboard is never touched, and that is said out loud',
        (WidgetTester tester) async {
      await _pump(tester, rows: <TimelineEntry>[
        _row('i', '🖼 PNG · 214 KB', minute: 1, image: true),
      ]);
      await _enterSelection(tester, '🖼 PNG · 214 KB');
      await tester.tap(find.byKey(const ValueKey<String>('selection.copy')));
      await tester.pumpAndSettle();

      expect(clipboard, isEmpty, reason: 'writing an empty string would silently wipe the user\'s last copy');
      expect(_lastToast(tester), _zh.selectionCopiedNothing);
      // Not a single character copied ⇒ stay in multi-select so the user can re-pick.
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsOneWidget);
    });
  });

  group('③ hand to AI organize: take the controlled pipeline, and never overwrite unsent user text', () {
    testWidgets('🔴 unsent text in the composer ⇒ refuse, name the reason, zero bytes on the wire, buffer untouched',
        (WidgetTester tester) async {
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
      ]);
      h.controller.setBuffer('还没发出去的话');
      await tester.pump();

      await _enterSelection(tester, '第一句');
      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);

      expect(_lastToast(tester), _zh.selectionOrganizeBufferBusy);
      expect(
        h.controller.buffer,
        '还没发出去的话',
        reason: '🔴 content-loss red line: that sentence must not change by a single character',
      );
      expect(h.composeFrames, isEmpty, reason: 'a refusal must put no frame on the wire');
      expect(h.controller.isAiComposing, isFalse);
      // Stay in multi-select: after the condition is cleared, tap again in place.
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsOneWidget);
      await _endRun(tester, h);
    });

    testWidgets('🔴 empty buffer ⇒ really takes startAiCompose, frame carries organize and those two sentences',
        (WidgetTester tester) async {
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
        _row('b', '第二句', minute: 2),
      ]);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第二句'));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);

      // Controlled pipeline: one compose:start frame, task=organize, source_text is those two rows.
      expect(h.composeFrames, hasLength(1));
      final Map<String, Object?> frame = h.composeFrames.single;
      expect(frame['task'], 'organize');
      expect(frame['source_text'], '第二句\n第一句');
      // 🔴 The contract is untouched: this pipeline **does not inject** (draft is always true).
      expect(frame['draft'], isTrue);
      expect(h.controller.isAiComposing, isTrue);
      expect(h.controller.buffer, '第二句\n第一句');
      expect(_lastToast(tester), _zh.selectionOrganizeStarted(2));
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsNothing);
      await _endRun(tester, h);
    });

    testWidgets('🔴 nothing checked ⇒ name the reason, not a silent no-op',
        (WidgetTester tester) async {
      // 0.2.27 precedent: "a control that changes nothing is worse than no control".
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
      ]);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第一句')); // uncheck the seed
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);
      expect(_lastToast(tester), _zh.selectionOrganizeNoSelection);
      expect(h.composeFrames, isEmpty);
      await _endRun(tester, h);
    });

    testWidgets('🔴 disconnected ⇒ name the reason, and the buffer was never written',
        (WidgetTester tester) async {
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
      ]);
      await _enterSelection(tester, '第一句');
      h.transport.pushStatus(SocketStatus.disconnected);
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);
      expect(_lastToast(tester), _zh.selectionOrganizeOffline);
      expect(
        h.controller.buffer,
        isEmpty,
        reason: 'the refusal happens before the buffer write — the order itself is the criterion',
      );
      expect(h.composeFrames, isEmpty);
      // Dropping the link arms the reconnect ladder (1s redial + 5s timer).
      // That is unrelated to this assertion, but `flutter_test` will go red
      // at end-of-body because it is still pending — let it connect and
      // finish, do not let an unrelated failure impersonate a feature failure.
      // ⚠️ Deliberately do not call `reconnect.stop()`: measured, under fake
      // async it **never returns**, and the whole suite hangs (worse than a
      // red — a hung test bench tells you nothing).
      h.transport.pushStatus(SocketStatus.connected);
      // 8s: long enough for the ladder's 5-second "stable window" timer to
      // burn out (`reconnect.dart`'s _stableTimer), while the sessionLost
      // 10-second clock is already cancelled the moment reconnect succeeds.
      await tester.pump(const Duration(seconds: 8));
      await _endRun(tester, h);
    });

    testWidgets('🔴 organize after select-all: same path, count matches the list',
        (WidgetTester tester) async {
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
        _row('b', '第二句', minute: 2),
        _row('c', '第三句', minute: 3),
      ]);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.byKey(const ValueKey<String>('selection.selectAll')));
      await tester.pump();
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey<String>('selection.count')))
            .data,
        _zh.selectionCount(3),
      );

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);
      expect(h.composeFrames.single['source_text'], '第三句\n第二句\n第一句');
      expect(_lastToast(tester), _zh.selectionOrganizeStarted(3));
      await _endRun(tester, h);
    });
  });

  // ══ ④ the other two content-safety gates ═══════════════════════════════════
  //
  // W5a adversarial review P1-6: `checkBatchOrganize` has six named refusals,
  // of which **three** are content-safety (`bufferBusy` / `speechInFlight` /
  // `isAiComposing`). Group ③ above only wiring-proved the first; the other
  // two have **pure-function unit tests only**
  // (`selection_batch_actions_test.dart:214,218`) — and this file's header
  // says verbatim that pure-function unit tests are structurally blind to
  // "is it wired". This group covers those two.
  //
  // 🔴 **Wiring is not one sentence, it is two**, and either can break
  // alone, so each has its own assertion:
  //   ① the gate is still there (`batch_actions.dart`'s `if (...) return ...`);
  //   ② the page **really fed that fact to it** (`chat_flow_selection.dart`'s
  //      `isAiComposing:` / `speechInFlight:` arguments).
  // Failure class ② has a name in this repo: R11 — "the layer making the
  // judgement does not have the facts it needs to make it", and **pure-
  // function unit tests are forever green on it**, because they test what
  // happens after the facts are fed correctly.
  group('④ the other two content-safety gates: speech in flight / AI running', () {
    testWidgets('🔴 currently speaking (recording) ⇒ refuse, name the reason, zero frames on the wire, buffer not written a single character',
        (WidgetTester tester) async {
      // "Currently speaking" is raised by the **production FSM** (see
      // [_enterRecording]'s header: why we do not take the real gesture, and
      // the FakeAsync deadlock measured on that path). The page reads it via
      // `controller.isRecording` → that argument in `chat_flow_selection.dart`,
      // all production layers.
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
      ]);
      await _enterSelection(tester, '第一句');
      await _enterRecording(tester, h);

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);

      expect(_lastToast(tester), _zh.selectionOrganizeRecording);
      expect(h.composeFrames, isEmpty, reason: 'a refusal must put no frame on the wire');
      // 🔴 The content-safety half: the batch text was **not** written into
      // the buffer. Under the manual policy that utterance would
      // `_foldIntoBuffer` into the same buffer when it finishes, and
      // organize-done is a **wholesale replace** ⇒ writing it in first is
      // scheduling a guaranteed overwrite of the sentence just spoken.
      expect(h.controller.buffer, isEmpty, reason: '🔴 content-loss red line');
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsOneWidget);

      // Swipe-up cancel: RECORDING → IDLE, do not leave a still-recording
      // FSM for the end-of-body `!timersPending` assertion.
      h.controller.session.fsm.onPttCancel();
      await tester.pump();
      await _endRun(tester, h);
    });

    testWidgets('🔴 spoken, final not yet back (processing) ⇒ the other half of the same gate, same refusal',
        (WidgetTester tester) async {
      // 🔴 **Why this case must exist on its own**: the production criterion
      // is an `||`, **two terms** (`isRecording || sessionState == processing`).
      // Testing only recording, deleting the second term still leaves that
      // test fully green — and "spoken, final not yet back" is exactly the
      // stretch where that sentence has **not yet landed in the buffer**,
      // i.e. the stretch where it is easiest to wipe.
      // 0.2.52 §3 law: changing one spot going red only proves that one spot.
      //
      // ⚠️ `fsm.onPttUp()` is **the same call shared by two production
      // entries**, not a shortcut this test invented: release goes through
      // `ptt_session.dart:756`, the server 5-minute hard cap goes through
      // `ptt_inbound.dart:100` (`audio:auto-stopped`). Both enter the same
      // state. Why we skip the real gesture: see [_enterRecording]
      // (teardown deadlock under FakeAsync, already measured).
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
      ]);
      await _enterSelection(tester, '第一句');
      await _enterRecording(tester, h);

      h.controller.session.fsm.onPttUp();
      await tester.pump();
      expect(h.controller.isRecording, isFalse, reason: 'already not recording');
      expect(
        h.controller.sessionState,
        SessionState.processing,
        reason: 'positive control: this case measures the second term of the `||`, so it must actually be in processing',
      );

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);

      expect(_lastToast(tester), _zh.selectionOrganizeRecording);
      expect(h.composeFrames, isEmpty, reason: 'a refusal must put no frame on the wire');
      expect(h.controller.buffer, isEmpty, reason: '🔴 content-loss red line');

      // Final arrives ⇒ processing → justDone → (1500ms) → idle. Must run
      // to completion, or the FSM's 15-second watchdog hangs until end-of-body
      // and goes red as a failure unrelated to this feature.
      h.controller.session.fsm.onSttFinal();
      await tester.pump(const Duration(milliseconds: 1600));
      await _endRun(tester, h);
    });

    testWidgets('🔴 AI still running ⇒ refuse, and the answer is "AI is running" not some other reason',
        (WidgetTester tester) async {
      // The AI is **really running**: manual + non-empty buffer ⇒ the edit
      // card floats up, `AiActionRow` appears inside the card ⇒ tap the real
      // 「整理」 on it (`chat_flow_edit_card.dart`'s
      // `onTask: (task) => s.controller.startAiCompose(task)`).
      //
      // 🔴 Order is deliberately "enter multi-select first, then start AI" —
      // this is measured: `_enterSelection` has `pumpAndSettle`, and once AI
      // is running that busy pill is a **never-stopping animation** ⇒ the
      // fake clock advances all the way to the 45-second watchdog firing and
      // aborting the run. The first version went red exactly that way, and
      // looked like the feature was broken: Expected 「上一次 AI 处理还在进行」,
      // Actual 「输入框里还有没发出的文字」— that is the buffer being restored
      // after the abort. (The same trap is already written once in
      // `_settleShort`'s comment.)
      //
      // ⚠️ **This gate today guards the "reason", not the "content" — writing
      // that down is cheaper than talking big.** On today's tree the buffer
      // is necessarily non-empty during a run (`ComposeBand` is disabled
      // while `isAiComposing`, `_clearBuffer` aborts the run first), so
      // stripping this gate falls onto `bufferBusy` and **still** refuses —
      // the user does not lose text, but they get a **false reason**
      // (R11: a status word must be able to answer "by what right do we say
      // this"). Where it is truly indispensable is
      // `AiComposeController.start`: when `isRunning` it returns
      // **null = success**, relying on the caller having asked first. The
      // day the buffer can go empty mid-run, this gate is the only door
      // between "a false success + a wholesale overwrite" and "a refusal".
      final _Harness h = await _pump(tester, rows: <TimelineEntry>[
        _row('a', '第一句', minute: 1),
      ]);
      await _enterSelection(tester, '第一句');

      // Ruling #4 (2026-08-11): the pills left the toolbar — they render only
      // inside the EDIT CARD (manual + non-empty buffer), so the real UI path
      // to a running AI compose now goes through manual policy. Mechanical
      // update only: what this case asserts (the selection gate's refusal
      // REASON) is untouched. Selection is entered BEFORE the buffer fills,
      // because the floating card overlays the timeline's bottom rows.
      await h.controller.toggleSendPolicy();
      h.controller.setBuffer('用户自己打的一段草稿');
      await tester.pump();
      await tester.tap(_aiTaskFinder(ComposeTask.organize));
      await tester.pump();
      expect(
        h.controller.isAiComposing,
        isTrue,
        reason: 'positive control: AI must actually be running, otherwise this case measures air',
      );
      expect(h.composeFrames, hasLength(1), reason: 'the first frame is the one that real run put on the wire');

      // PA-4 (Plan A′ SUP-5): the pill lives in the EDIT SHEET now, and the
      // sheet covers the selection bar — the real user path to the bar is one
      // collapse (which preserves the buffer AND the running AI; the gate
      // still has to refuse after it).
      await tester.tap(
        find.byKey(const ValueKey<String>('compose.sheet.collapse')),
      );
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
      await _settleShort(tester);

      expect(_lastToast(tester), _zh.selectionOrganizeAiBusy);
      expect(h.composeFrames, hasLength(1), reason: 'no second frame: the batch was not started');
      expect(
        h.controller.buffer,
        '用户自己打的一段草稿',
        reason: '🔴 that run\'s input must be untouched',
      );
      expect(find.byKey(const ValueKey<String>('selection.bar')), findsOneWidget);
      await _endRun(tester, h);
    });

    // ── Four languages: a refusal the user cannot read is the same as a silent no-op ──
    //
    // **One test per language**, not one test looping four times: pumping four
    // trees in one body lets the previous session re-arm its idle presence
    // poll, and an unrelated "Timer is still pending" impersonates a feature
    // failure.
    for (final AppLocale loc in AppLocale.values) {
      testWidgets('🔴 four languages (${loc.name}): both refusals are actually painted on screen',
          (WidgetTester tester) async {
        // The criterion is **that SnackBar actually appeared on the real
        // page**, not "a function returned an enum". Locale also takes the
        // production path (`ChatFlowPage.appSettings` → `_strings`), not this
        // test new-ing an AppStrings and comparing it to itself.
        //
        // ⚠️ Ruler (Ahem): `flutter_test`'s placeholder font is a full-em
        // square per glyph, much wider than a real device ⇒ "no overflow
        // here" is the **conservative direction** (no overflow under Ahem ⇒
        // a real device will not overflow), **the converse does not hold**:
        // do not use this case to argue a sentence "just fits" on a real
        // device.
        final AppStrings s = AppStrings.of(loc);
        final _Harness h = await _pump(
          tester,
          rows: <TimelineEntry>[_row('a', '第一句', minute: 1)],
          locale: loc,
        );
        await _enterSelection(tester, '第一句', strings: s);

        // ① speech in flight
        await _enterRecording(tester, h);
        await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
        await _settleShort(tester);
        expect(
          find.text(s.selectionOrganizeRecording),
          findsOneWidget,
          reason: '$loc — this refusal sentence did not appear on screen',
        );
        expect(tester.takeException(), isNull, reason: '$loc toast overflowed');
        h.controller.session.fsm.onPttCancel();
        await tester.pump();

        // ② AI running (ruling #4: the pill lives in the edit card ⇒ manual first)
        await h.controller.toggleSendPolicy();
        h.controller.setBuffer('draft');
        await tester.pump();
        await tester.tap(_aiTaskFinder(ComposeTask.organize));
        await tester.pump();
        expect(h.controller.isAiComposing, isTrue, reason: '$loc positive control');
        // PA-4: collapse the sheet to reach the selection bar (see the single
        // AI-busy case above for the reasoning).
        await tester.tap(
          find.byKey(const ValueKey<String>('compose.sheet.collapse')),
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey<String>('selection.organize')));
        await _settleShort(tester);
        expect(
          find.text(s.selectionOrganizeAiBusy),
          findsOneWidget,
          reason: '$loc — this refusal sentence did not appear on screen',
        );
        expect(tester.takeException(), isNull, reason: '$loc toast overflowed');
        await _endRun(tester, h);
      });
    }

    test('🔴 positive control: those two sentences really are four copies, not one sentence copied four times', () {
      // Each of the four testWidgets above only compares against its own
      // language ⇒ a table that returns zh for all four languages would
      // leave them **all green**. This is the only assertion that can catch
      // that table.
      for (final String Function(AppStrings) pick in <String Function(AppStrings)>[
        (AppStrings s) => s.selectionOrganizeRecording,
        (AppStrings s) => s.selectionOrganizeAiBusy,
      ]) {
        final Set<String> seen = <String>{
          for (final AppLocale loc in AppLocale.values) pick(AppStrings.of(loc)),
        };
        expect(seen, hasLength(AppLocale.values.length));
        for (final String v in seen) {
          expect(v.trim(), isNotEmpty);
        }
      }
    });
  });
}
