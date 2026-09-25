// Card NR-97 — every paragraph on the long-recording screens shows its
// duration and its word count.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md
//     NR-97 row (the rulings)
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §4.4 and its NR-97 correction block
//   apps/mobile/lib/src/timeline/entry_metrics.dart (THE counter and THE
//     duration formatter; the header must not grow a second one)
//
// The deliverable is 「what the user reads above each paragraph」 on two
// screens, and both are `ArticlePage`: the read-back form reached from the
// light-record card, and the in-progress form production pushes when the
// user presses Start. Both are mounted through their real doors, with rows
// that came in as wire finals (anti-façade ⑥).
//
// The expected numbers are built from `entryWordCount` / `textWordCount` and
// `formatEntryDuration` — the functions the timeline row chip uses — so a
// header that counts or formats its own way goes red here. The texts mix CJK
// and Latin on purpose: there, `text.length` and the shared count disagree
// (「今天先过 two 件事。」 is 7 words and 12 code units), so a naive length
// cannot pass by coincidence.
//
// ⚠️ `runAsync` around every step that awaits production futures; pumped
// after every final so the settles do not interleave (both reasons are in
// article_paragraph_screen_test.dart's helper doc).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/entry_metrics.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart' show articleMembersOf;
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart' show LiveDraftTile;
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';
import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart' show makePcm;

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const String _r0 = '今天先过 two 件事。';
const String _r1 = '第一件是 inventory 口径';
const String _r2 = '第二件是 purchase 节奏';

/// What the header must read, spelled with the timeline row's own pieces.
String _expected(int? durationMs, List<String> texts, AppStrings s) {
  int words = 0;
  for (final String t in texts) {
    words += textWordCount(t);
  }
  final String count = s.entryWordCountLabel(words);
  return durationMs == null
      ? count
      : '${formatEntryDuration(durationMs)} · $count';
}

String _textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data ?? '';

Finder _onPage(Finder f) =>
    find.descendant(of: find.byType(ArticlePage), matching: f);

// ── the in-progress door (as article_live_screen_test.dart mounts it) ───────

Future<ArticleRig> _mountPhone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final ArticleRig r = ArticleRig();
  final login = newTestLogin(
    transport: r.transport,
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-nr97', email: 'x@example.com', plan: 'pro'),
    ),
  );
  await tester.runAsync(login.hydrate);
  final account = newTestCloudSummary(
    login: login,
    fetcher: fixedCloudSummary(testSummary(continuousMinutes: 30)),
  );
  addTearDown(() async {
    account.dispose();
    login.dispose();
    await r.dispose();
  });
  await tester.runAsync(() async {
    account.refresh();
    await Future<void>.delayed(Duration.zero);
  });
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(
        controller: r.controller,
        cloudSummary: account,
        isSignedIn: () => login.isLoggedIn,
      ),
    ),
  );
  await tester.pump();
  return r;
}

Future<void> _settle(WidgetTester tester) async {
  for (int i = 0; i < 4; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _startFromEntry(WidgetTester tester, ArticleRig r) async {
  await tester.tap(find.byKey(ContinuousEntryKeys.row));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ContinuousSheetKeys.start));
  await _settle(tester);
  r.recorder.feed(makePcm(6400));
}

Future<void> _final(
  WidgetTester tester,
  ArticleRig r,
  String text,
  int idx, {
  bool isSegment = true,
  required int durationMs,
}) async {
  await tester.runAsync(
    () => r.say(text, idx, isSegment: isSegment, durationMs: durationMs),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _interim(
  WidgetTester tester,
  ArticleRig r,
  String text,
  int idx,
) async {
  await tester.runAsync(() async {
    r.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': text,
      'confidence': 0.4,
      'language': 'zh',
      'segment_idx': idx,
    });
    await pumpEventQueue();
  });
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _wrapUp(WidgetTester tester, ArticleRig r) async {
  if (r.controller.hasLiveDraft) {
    await tester.runAsync(() => r.controller.pttUp());
    await _final(tester, r, '收尾', 99, isSegment: false, durationMs: 1000);
  }
  r.session.endContinuous();
  await tester.pump(const Duration(seconds: 5));
  await tester.pump(const Duration(seconds: 5));
}

// ── the read-back door (as article_paragraph_screen_test.dart reaches it) ───

Future<String> _recordAndStop(WidgetTester tester, ArticleRig r) async {
  await mountLightRecordScreen(tester, r);
  Future<void> step(Future<void> Function() f) async {
    await tester.runAsync(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  late String id;
  await step(() async => id = await r.startRecording());
  await step(() => r.say(_r0, 0, isSegment: true, durationMs: 45000));
  await step(() => r.say(_r1, 1, isSegment: true, durationMs: 30000));
  await step(() => r.controller.pttUp());
  await step(() => r.say(_r2, 2, isSegment: false, durationMs: 40000));
  await step(() async => r.session.endContinuous());
  return id;
}

// ── a hand-built page, for the rows the wire cannot produce ─────────────────

const String _kArticleId = 'a0-1788000000000097';

TimelineEntry _member(String id, String text, int? offsetMs, int? durationMs) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      durationMs: durationMs,
      articleId: _kArticleId,
      articleOffsetMs: offsetMs,
      createdAt: DateTime.utc(2026, 9, 24, 9),
      updatedAt: DateTime.utc(2026, 9, 24, 9),
    );

TimelineEntry _head() => TimelineEntry(
  id: 'loc_head',
  clientId: _kArticleId,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: '会议记录',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kArticle,
  articleId: _kArticleId,
  origin: 'cloud',
  durationMs: 85000,
  segmentsCount: 3,
  createdAt: DateTime.utc(2026, 9, 24, 9),
  updatedAt: DateTime.utc(2026, 9, 24, 9, 1),
);

Future<void> _mountPage(
  WidgetTester tester,
  List<TimelineEntry> rows,
  AppStrings strings,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ArticlePage(head: _head(), rows: rows, strings: strings),
    ),
  );
  await tester.pumpAndSettle();
}

/// D-15: the line is readable only if the RENDERED paragraph holds all of it
/// on one line inside the screen — not if `Text.data` is right.
void _expectUncut(WidgetTester tester, String key, {required double screen}) {
  final RenderParagraph rp = tester.renderObject<RenderParagraph>(
    find.byKey(Key(key)),
  );
  expect(rp.didExceedMaxLines, isFalse, reason: '$key must not be cut');
  final double intrinsic = rp.getMaxIntrinsicWidth(double.infinity);
  expect(
    intrinsic,
    lessThanOrEqualTo(rp.size.width + 0.01),
    reason:
        '$key must be laid out on one line at its full width '
        '(intrinsic $intrinsic vs box ${rp.size.width})',
  );
  expect(
    tester.getTopRight(find.byKey(Key(key))).dx,
    lessThanOrEqualTo(screen - 16 + 0.01),
    reason: '$key must end inside the page gutter',
  );
}

void main() {
  test('fixture fact: on these texts the shared count and text.length '
      'disagree', () {
    expect(textWordCount(_r0), 7);
    expect(_r0.length, 12);
    expect(
      textWordCount(_r1) + textWordCount(_r2),
      isNot(_r1.length + _r2.length),
    );
  });

  testWidgets('🔴 read-back page: each paragraph header shows the shared '
      'duration and count', (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    final String id = await _recordAndStop(tester, r);
    final List<TimelineEntry> members = articleMembersOf(r.store, id);
    expect(
      <String>[for (final TimelineEntry m in members) m.displayText],
      <String>[_r0, _r1, _r2],
      reason: 'positive control: three rows, one per final',
    );

    await tester.tap(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();

    expect(
      _textOf(tester, 'article.paragraph.0'),
      '00:00–00:45',
      reason: 'positive control: the range is untouched',
    );
    expect(
      _textOf(tester, 'article.paragraph.0.metrics'),
      _expected(45000, <String>[_r0], _zh),
    );
    expect(
      _textOf(tester, 'article.paragraph.0.metrics'),
      '45s · 7 字',
      reason: 'the same claim, spelled out',
    );
    expect(_textOf(tester, 'article.paragraph.1'), '00:45–01:55');
    expect(
      _textOf(tester, 'article.paragraph.1.metrics'),
      _expected(70000, <String>[_r1, _r2], _zh),
    );
    // The count is the sum of the row chips, which is what the stats total
    // adds up (asset_inventory.dart Σ entryWordCount).
    expect(
      _textOf(tester, 'article.paragraph.1.metrics'),
      '1:10 · ${_zh.entryWordCountLabel(entryWordCount(members[1])! + entryWordCount(members[2])!)}',
    );
  });

  testWidgets('🔴 recording page: the open paragraph counts settled rows '
      'only, grows as rows settle, and ignores the draft', (
    WidgetTester tester,
  ) async {
    final ArticleRig r = await _mountPhone(tester);
    await _startFromEntry(tester, r);
    await _final(tester, r, _r0, 0, durationMs: 45000);
    await _final(tester, r, _r1, 1, durationMs: 30000);

    expect(
      _textOf(tester, 'article.paragraph.1'),
      '00:45',
      reason: 'positive control: paragraph 1 is still open (start only)',
    );
    final String settledOnly = _expected(30000, <String>[_r1], _zh);
    expect(_textOf(tester, 'article.paragraph.1.metrics'), settledOnly);

    const String draft = '这是还没定稿的 preview 文字很多很多';
    await _interim(tester, r, draft, 2);
    expect(
      _onPage(find.byType(LiveDraftTile)),
      findsOneWidget,
      reason: 'positive control: the interim is on screen as the draft',
    );
    expect(
      r.controller.liveText,
      contains('preview'),
      reason: 'positive control: the draft holds the interim text',
    );
    expect(
      _textOf(tester, 'article.paragraph.1.metrics'),
      settledOnly,
      reason: 'interim text is never counted',
    );

    await _final(tester, r, _r2, 2, durationMs: 40000);
    final String grown = _expected(70000, <String>[_r1, _r2], _zh);
    expect(
      _textOf(tester, 'article.paragraph.1'),
      '00:45',
      reason: 'positive control: still the open paragraph',
    );
    expect(
      _textOf(tester, 'article.paragraph.1.metrics'),
      grown,
      reason: 'one more settled row raises the duration and the count',
    );
    expect(
      textWordCount(_r1) + textWordCount(_r2),
      greaterThan(textWordCount(_r1)),
    );

    // The closed paragraph above it reads the same as on the read-back page.
    expect(
      _textOf(tester, 'article.paragraph.0.metrics'),
      _expected(45000, <String>[_r0], _zh),
    );
    await _wrapUp(tester, r);
  });

  testWidgets('🔴 a row without a length: no duration is shown, the count '
      'still is', (WidgetTester tester) async {
    final List<TimelineEntry> rows = <TimelineEntry>[
      _member('r0', _r0, 0, 45000),
      _member('r1', _r1, 45000, null),
      _member('r2', _r2, 45000, 40000),
    ];
    await _mountPage(tester, rows, _zh);

    expect(
      _textOf(tester, 'article.paragraph.0.metrics'),
      '45s · 7 字',
      reason:
          'positive control: a paragraph whose rows all have a '
          'length shows its duration',
    );
    expect(
      _textOf(tester, 'article.paragraph.1'),
      '00:45',
      reason: 'positive control: rows 1 and 2 form paragraph 1',
    );
    expect(
      _textOf(tester, 'article.paragraph.1.metrics'),
      _expected(null, <String>[_r1, _r2], _zh),
    );
    expect(
      _textOf(tester, 'article.paragraph.1.metrics'),
      isNot(contains('·')),
      reason: 'no duration clause, not a guessed one',
    );
  });

  testWidgets('a paragraph whose start is unknown still shows its count', (
    WidgetTester tester,
  ) async {
    await _mountPage(tester, <TimelineEntry>[
      _member('r0', _r0, null, 30000),
    ], _zh);
    expect(
      find.byKey(const Key('article.paragraph.0')),
      findsNothing,
      reason: 'no range for an unknown start (unchanged)',
    );
    expect(
      _textOf(tester, 'article.paragraph.0.metrics'),
      _expected(null, <String>[_r0], _zh),
      reason: 'the duration is measured from the start, so it goes too',
    );
  });

  testWidgets('🔴 360 dp phone, nine locales: the range and the metrics are '
      'never cut', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    // An hour in, a full paragraph, a four-digit count: the widest header a
    // real recording produces.
    final String long = List<String>.filled(1234, 'word').join(' ');
    final List<TimelineEntry> rows = <TimelineEntry>[
      _member('r0', '$long.', 3900000, 89000),
    ];
    String? widest;
    double widestPx = 0;
    for (final AppLocale l in AppLocale.values) {
      final AppStrings s = AppStrings.of(l);
      await _mountPage(tester, rows, s);
      expect(_textOf(tester, 'article.paragraph.0'), '65:00–66:29');
      expect(
        _textOf(tester, 'article.paragraph.0.metrics'),
        _expected(89000, <String>['$long.'], s),
      );
      _expectUncut(tester, 'article.paragraph.0', screen: 360);
      _expectUncut(tester, 'article.paragraph.0.metrics', screen: 360);
      final double w = tester
          .renderObject<RenderParagraph>(
            find.byKey(const Key('article.paragraph.0.metrics')),
          )
          .getMaxIntrinsicWidth(double.infinity);
      if (w > widestPx) {
        widestPx = w;
        widest = l.name;
      }
    }
    // Positive control: the loop really ran every locale and measured text.
    debugPrint('NR-97 widest metrics line: $widest (${widestPx.round()} px)');
    expect(widest, isNotNull);
    expect(widestPx, greaterThan(0));
  });
}
