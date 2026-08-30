// owner 2026-08-30: 「手机端的全部历史记录中复制」 — on the full-history page,
// copying a recording copied its title.
//
// The real page over a real store (the same rig history_page_interactions_test
// uses), seeded with one finished recording and one ordinary row. The
// recording's members are minted through `buildFromUtterance` with an article
// id and offset, and the head through `buildArticleHeadOf` +
// `refreshArticleHeadOf` — the production builders, so the head's title is the
// derived one and not a fixture's guess.
//
// ── RED, MEASURED (pre-fix lib restored from HEAD, this file unchanged) ────────
//   ① multi-select (head + normal) → 复制:
//        Expected: '00:00–00:30 …\n00:30–01:00 …\n01:00–01:30 …\n录完之后说的'
//          Actual: '<title>\n录完之后说的'
//   ② long-press the head → 复制: Actual: '<title>' (one line, no range).
//
// ⚠️ THIS PAGE DOES NOT COLLAPSE RECORDINGS (it lists every row, members
// included). That is a separate question from this card and is not changed
// here; what this file pins is that the head's copy is the whole piece on this
// page too, and that ticking the head beside its own segments does not copy
// the segments twice.

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_sqlite.dart'
    show TimelineStorageKind;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodCall, SystemChannels;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const AppStrings _zh = AppStringsZh();
const String kArt = 'a0-1788000000000000';

/// Longer than `ArticleSummary.kTitleMaxChars` (40), so the derived title is
/// a PREFIX of the first segment and `find.text(title)` matches the head row
/// alone rather than the head and its first member.
const String kFirst = '今天先过两件事，第一件是库存口径，第二件是采购节奏，第三件是月结日对齐，第四件是人手安排';
const String kPiece = '00:00–00:30 $kFirst\n'
    '00:30–01:00 第一件是库存口径\n'
    '01:00–01:30 第二件是采购节奏';

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

void _segment(TimelineStore store, String id, String text, int offsetMs) {
  store.buildFromUtterance(
    clientId: id,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    text: text,
    origin: 'cloud',
    durationMs: 30_000,
    articleId: kArt,
    articleOffsetMs: offsetMs,
  );
}

/// The real page over a real store: one finished recording (head + three
/// segments) that began a minute ago, and one ordinary row spoken afterwards.
Future<(TimelineStore, String)> _pump(WidgetTester tester) async {
  final TimelineStore store = newTestStore(
    deviceId: 'phone',
    owner: _FakeOwner('standalone|instance:pc-study', '书房电脑'),
  );
  addTearDown(store.dispose);
  buildArticleHeadOf(
    store,
    articleId: kArt,
    startedAt: DateTime.now().toUtc().subtract(const Duration(minutes: 1)),
  );
  _segment(store, 's1', kFirst, 0);
  _segment(store, 's2', '第一件是库存口径', 30_000);
  _segment(store, 's3', '第二件是采购节奏', 60_000);
  refreshArticleHeadOf(store, kArt);
  store.buildFromUtterance(
    clientId: 'later',
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    text: '录完之后说的',
    origin: 'paired',
  );
  final String title = store.findByClientId(kArt)!.displayText;
  expect(title, isNot(kFirst), reason: 'fixture: the title must be a prefix');
  expect(kFirst, startsWith(title));

  tester.view.physicalSize = const Size(800 * 3, 1400 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: HistoryPage(
        store: store,
        storageKind: TimelineStorageKind.sqlite,
      ),
    ),
  );
  await tester.pump();
  return (store, title);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<String> clipboard;

  setUp(() {
    clipboard = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (
      MethodCall call,
    ) async {
      if (call.method == 'Clipboard.setData') {
        clipboard.add(
          (call.arguments as Map<Object?, Object?>)['text'] as String,
        );
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  testWidgets('🔴 ① multi-select: recording + normal entry → the recording is '
      'expanded with its times, the entry unchanged, oldest first',
      (WidgetTester tester) async {
    final (TimelineStore _, String title) = await _pump(tester);

    // Hold the head → 多选 (seeds the selection with the head) → tick the
    // ordinary row → the toolbar's 复制.
    await tester.longPress(find.text(title));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.selectionEnter));
    await tester.pumpAndSettle();
    await tester.tap(find.text('录完之后说的'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.selectionCopy));
    await tester.pumpAndSettle();

    expect(clipboard, <String>['$kPiece\n录完之后说的']);
    // The toast counts the recording as ONE record.
    expect(find.text(_zh.selectionCopiedRecords(2)), findsOneWidget);
  });

  testWidgets('🔴 ② long-press the head → 复制 copies the whole recording',
      (WidgetTester tester) async {
    final (TimelineStore _, String title) = await _pump(tester);

    await tester.longPress(find.text(title));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.entryCopy));
    await tester.pumpAndSettle();

    expect(clipboard, <String>[kPiece]);
  });

  testWidgets('③ 全选 on this page ticks the head AND its segments — copied once',
      (WidgetTester tester) async {
    final (TimelineStore _, String title) = await _pump(tester);

    await tester.longPress(find.text(title));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.selectionEnter));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.selectionSelectAll));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.selectionCopy));
    await tester.pumpAndSettle();

    expect(clipboard, <String>['$kPiece\n录完之后说的']);
    expect(find.text(_zh.selectionCopiedRecords(2)), findsOneWidget,
        reason: 'the three segments are inside the piece, not three more');
  });

  testWidgets('④ negative control: the head row on screen still shows the '
      'title only', (WidgetTester tester) async {
    final (TimelineStore _, String title) = await _pump(tester);
    expect(find.text(title), findsOneWidget);
    expect(find.textContaining('00:30'), findsNothing,
        reason: 'ranges are for the clipboard, not the list');
  });
}
