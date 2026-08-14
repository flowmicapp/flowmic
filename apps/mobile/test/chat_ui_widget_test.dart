// WP-R3-2 acceptance — the visual contract renders per demo: five-state badges,
// edited corner mark, 原文 source line, record-only PTT neutral bar, destination
// two-state badge. SPEC-REF: docs/ui-design/demo/mobile.html; master-plan §4.0.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/destination_badge.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _entry({
  required EntryStatus status,
  required Delivery delivery,
  bool edited = false,
  String? processMode,
  String source = '正文',
  String? output,
  String origin = 'paired',
  String? failureReason,
  bool cachedByVerdict = false,
}) {
  final DateTime now = DateTime.utc(2026, 7, 23, 14, 32);
  return TimelineEntry(
    id: 'loc_mobile_c',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: delivery,
    sourceText: source,
    outputText: output ?? source,
    processMode: processMode,
    status: status,
    edited: edited,
    origin: origin,
    failureReason: failureReason,
    cachedByVerdict: cachedByVerdict,
    createdAt: now,
    updatedAt: now,
  );
}

/// Taps its child to open the long-press context menu for [entry].
Widget _menuOpener(TimelineEntry entry) => Builder(
  builder: (BuildContext context) => Center(
    child: GestureDetector(
      onTap: () => showEntryContextMenu(
        context,
        entry,
        strings: AppStrings(AppLocale.zh),
      ),
      child: const Text('open'),
    ),
  ),
);

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('injected row shows ✓ 已投递 (card L7: was 已注入)', (WidgetTester tester) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.injected,
            delivery: Delivery.inject,
          ),
        ),
      ),
    );
    // Card L7 / owner 2026-08-02「不要显示已注入了」— the phone speaks segment ①.
    expect(find.textContaining('已投递'), findsOneWidget);
    expect(find.textContaining('已注入'), findsNothing);
    expect(find.text('正文'), findsOneWidget);
  });

  // N2 / RV-43 §4 — the two faces of `cached`. THIS PAIR IS THE POINT: a row
  // waiting for a verdict and a row a verdict settled as 「没投递」 are the same
  // EntryStatus and must never read the same, or the amber pill answers two
  // different questions with one word (CLAUDE.md §3, this repo's #1 bug shape).
  testWidgets('cached row still awaiting a verdict shows ⏳ 投递中', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(status: EntryStatus.cached, delivery: Delivery.inject),
        ),
      ),
    );
    expect(find.textContaining('投递中'), findsOneWidget);
    expect(find.textContaining('未投递'), findsNothing);
  });

  testWidgets('cached row a verdict settled shows 📥 待投递 — and NOT 投递中', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.cached,
            delivery: Delivery.inject,
            cachedByVerdict: true,
          ),
        ),
      ),
    );
    // 🔴 Card L7 — was '📥 未投递'. The code on this face is never terminal, so the
    // queue still owes this row: "still queued", not "gave up" (15 册 §2.0.1).
    expect(find.text('📥 待投递'), findsOneWidget);
    // The in-flight word must be nowhere on this row. Asserted with a SUBSTRING
    // search rather than an exact one so the two labels cannot be made to
    // overlap textually later (e.g. 「未投递中」) and quietly re-merge the faces.
    expect(find.textContaining('投递中'), findsNothing);
  });

  // 未投递 means "kept so it can be redelivered" (RV-43 §1). Copy that says so while the row offers
  // no way to do it would be a claim about a capability the UI withholds.
  testWidgets('未投递 row offers 重发, reusing the ✗ row affordance', (
    WidgetTester tester,
  ) async {
    TimelineEntry? retried;
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.cached,
            delivery: Delivery.inject,
            cachedByVerdict: true,
          ),
          onRetry: (TimelineEntry e) => retried = e,
        ),
      ),
    );
    final Finder resend = find.byKey(
      const ValueKey<String>('entry.resend.loc_mobile_c'),
    );
    expect(resend, findsOneWidget);
    await tester.tap(resend);
    expect(retried, isNotNull);
  });

  // …while a row still in flight must NOT: its words are on their way, and a
  // second delivery would put them in twice.
  testWidgets('投递中 row offers no 重发', (WidgetTester tester) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(status: EntryStatus.cached, delivery: Delivery.inject),
          onRetry: (TimelineEntry _) {},
        ),
      ),
    );
    expect(
      find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
      findsNothing,
    );
  });

  // RV-43 §1 narrowed `failed` to 「前提不成立，或动作本身失败」, so the copy no
  // longer says 「注入失败」 — the commonest case sends no key at all.
  testWidgets('failed row shows ✗ 未成功', (WidgetTester tester) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(status: EntryStatus.failed, delivery: Delivery.inject),
        ),
      ),
    );
    expect(find.text('✗ 未投递 · 未成功'), findsOneWidget); // card L7: first word of the three-state phrase
  });

  // The reason line belongs to ✗ only (RV-43 §4 gives 未投递 no reason column),
  // and a 未投递 row can be carrying a code from an earlier attempt.
  testWidgets('未投递 row does NOT render a stale failure code', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.cached,
            delivery: Delivery.inject,
            cachedByVerdict: true,
            // ⚠️ Card F2 (2026-08-02) — **the sample code changed; the assertion
            // rule did not change by a single word.**
            // The original sample was `INJECT_FOCUS_LOST`, and it is now a
            // **PC-authored injection-segment verdict**
            // ⇒ lands on `DeliveryFace.deliveredNotInjected` (「已投递 · 未注入」),
            // and that face **is designed to print the named code** (several
            // codes share one face; same argument as ✗/⛔).
            // This case tests "the 待投递 face does not print a stale code", so
            // the sample must still land on that face:
            // `INJECT_NOT_IN_ROOM` is the relay-authored, retryable,
            // `mode:'cached'` class
            // (15 册 §3.2 "PC busy" row: after being occupied, this is the one
            // that lands most often).
            failureReason: 'INJECT_NOT_IN_ROOM',
          ),
        ),
      ),
    );
    expect(find.text('· INJECT_NOT_IN_ROOM'), findsNothing);
  });

  // RV-14 / C4: the named code must render next to the pill on a failed row,
  // and must NOT appear on an injected row (even if a stale reason lingered).
  testWidgets('failed row renders the raw failureReason; injected does not', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.failed,
            delivery: Delivery.inject,
            failureReason: 'INJECT_NO_RESULT',
          ),
        ),
      ),
    );
    expect(find.text('· INJECT_NO_RESULT'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.injected,
            delivery: Delivery.inject,
            failureReason: 'INJECT_NO_RESULT',
          ),
        ),
      ),
    );
    expect(find.text('· INJECT_NO_RESULT'), findsNothing);
  });

  testWidgets('noted row shows 仅记录 with inbox icon', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(status: EntryStatus.noted, delivery: Delivery.none),
        ),
      ),
    );
    expect(find.text('仅记录'), findsOneWidget);
    expect(find.byIcon(Icons.inbox_outlined), findsOneWidget);
  });

  testWidgets('edited mark is inline in the meta row — it does not cover '
      'status or last-delivery time', (
    WidgetTester tester,
  ) async {
    final DateTime spoken = DateTime.utc(2026, 7, 23, 14, 32);
    final DateTime resent = DateTime.utc(2026, 7, 23, 15, 10);
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: TimelineEntry(
            id: 'loc_mobile_c',
            clientId: 'c',
            mode: FlowMode.realtime,
            delivery: Delivery.inject,
            sourceText: '正文',
            outputText: '正文',
            status: EntryStatus.injected,
            edited: true,
            origin: 'paired',
            createdAt: spoken,
            updatedAt: resent,
            lastResentAt: resent,
          ),
        ),
      ),
    );
    expect(find.text('已编辑'), findsOneWidget);
    expect(
      find.textContaining('已投递'),
      findsOneWidget,
    ); // status colour still there (card L7: the word is 已投递 now)
    expect(find.textContaining('上次重发'), findsOneWidget);

    final Rect edited = tester.getRect(find.text('已编辑'));
    final Rect status = tester.getRect(find.textContaining('已投递'));
    expect(
      edited.overlaps(status),
      isFalse,
      reason: '已编辑 must not sit on top of the status pill',
    );
  });

  testWidgets('WP-R4-6 ⑦: polish-skipped corner mark is orthogonal to status', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(status: EntryStatus.cached, delivery: Delivery.inject),
          polishSkippedLabel: '润色未生效·已用原文',
        ),
      ),
    );
    expect(find.text('润色未生效·已用原文'), findsOneWidget);
    // …and the delivery face still reads through (N2 copy: ⏳ 投递中).
    expect(find.textContaining('投递中'), findsOneWidget);
  });

  testWidgets('translate row shows the 原文 source line', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: AppStrings(AppLocale.zh),
          entry: _entry(
            status: EntryStatus.injected,
            delivery: Delivery.inject,
            processMode: 'translate',
            source: '报告已发送',
            output: 'The report has been sent.',
          ),
        ),
      ),
    );
    expect(find.text('The report has been sent.'), findsOneWidget);
    expect(find.textContaining('原文：报告已发送'), findsOneWidget);
  });

  testWidgets('record-only PTT bar is the neutral 仅记录 bar', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.noted)));
    expect(find.text('按住 说话 · 仅记录'), findsOneWidget);
  });

  testWidgets('idle PTT bar vs disabled PTT bar', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.idle)));
    expect(find.text('按住 说话'), findsOneWidget);
    await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.disabled)));
    expect(find.text('未连接 · 暂时不能说话'), findsOneWidget);
  });

  testWidgets('destination header badge two states + neutral disconnected', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const DestinationHeaderBadge(
          recordOnly: false,
          label: 'WeChat',
          fixed: false,
          connected: true,
        ),
      ),
    );
    expect(find.text('→ WeChat'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(
        const DestinationHeaderBadge(
          recordOnly: true,
          label: '仅记录',
          fixed: false,
          connected: true,
        ),
      ),
    );
    expect(find.text('→ 仅记录'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(
        const DestinationHeaderBadge(
          recordOnly: false,
          label: '—',
          fixed: false,
          connected: false,
        ),
      ),
    );
    expect(find.text('→ —'), findsOneWidget);
  });

  testWidgets('cloud instance destination badge is locked to 仅记录', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const DestinationHeaderBadge(
          recordOnly: true,
          label: '仅记录',
          fixed: true,
          connected: true,
        ),
      ),
    );
    expect(find.text('→ 仅记录'), findsOneWidget);
    expect(find.byIcon(Icons.lock_outline), findsOneWidget);
  });

  testWidgets(
    'R6 T-5: the auto-stop notice now rides the SINGLE banner slot (the '
    'standalone AutoStoppedBanner is gone) and keeps its fail-loud copy + ✕',
    (WidgetTester tester) async {
      bool dismissed = false;
      await tester.pumpWidget(
        _wrap(
          BannerSlot(
            queue: BannerQueue()
              ..push(
                BannerItem(
                  id: BannerIds.autoStop,
                  severity: BannerSeverity.degraded,
                  message: '录音已达 5 分钟上限，已自动停止',
                  dismissible: true,
                  onAction: () => dismissed = true,
                ),
              ),
            strings: AppStrings.of(AppLocale.zh),
          ),
        ),
      );
      expect(find.text('录音已达 5 分钟上限，已自动停止'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.close));
      expect(dismissed, isTrue);
    },
  );

  testWidgets('M2: a failed PC-bound text row carries an inline 重发 that fires '
      'the retry; other rows never show it', (WidgetTester tester) async {
    TimelineEntry? retried;
    Widget tile(TimelineEntry e) => _wrap(
      ChatMessageTile(
        queued: false,
        canResendImage: false,
        strings: AppStrings(AppLocale.zh),
        entry: e,
        onRetry: (TimelineEntry x) => retried = x,
      ),
    );

    await tester.pumpWidget(
      tile(_entry(status: EntryStatus.failed, delivery: Delivery.inject)),
    );
    expect(find.text('重发'), findsOneWidget);
    await tester.tap(find.text('重发'));
    expect(retried, isNotNull);

    // A delivered row has nothing to retry.
    await tester.pumpWidget(
      tile(_entry(status: EntryStatus.injected, delivery: Delivery.inject)),
    );
    expect(find.text('重发'), findsNothing);

    // A failed CLOUD row has no PC target — same gate as the menu's 补投.
    await tester.pumpWidget(
      tile(
        _entry(
          status: EntryStatus.failed,
          delivery: Delivery.none,
          origin: 'cloud',
        ),
      ),
    );
    expect(find.text('重发'), findsNothing);
  });

  testWidgets('R6 P0-R4: a paired entry offers 注入到 PC in the context menu', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        _menuOpener(
          _entry(status: EntryStatus.injected, delivery: Delivery.inject),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('注入到 PC'), findsOneWidget);
    expect(find.text('编辑'), findsOneWidget);
    expect(find.text('复制'), findsOneWidget);
    expect(find.text('删除'), findsOneWidget);
  });

  testWidgets('R6 P0-R4: a cloud-instance entry HIDES 注入到 PC (no PC target) '
      'but keeps edit/copy/delete', (WidgetTester tester) async {
    await tester.pumpWidget(
      _wrap(
        _menuOpener(
          _entry(
            status: EntryStatus.noted,
            delivery: Delivery.none,
            origin: 'cloud',
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('注入到 PC'), findsNothing);
    expect(find.text('补投到当前焦点窗口'), findsNothing);
    expect(find.text('编辑'), findsOneWidget);
    expect(find.text('复制'), findsOneWidget);
    expect(find.text('删除'), findsOneWidget);
  });
}
