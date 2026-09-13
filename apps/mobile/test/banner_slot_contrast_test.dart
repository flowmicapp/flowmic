// P0 2026-09-09 (owner, on a phone): 「转录界面上方的横幅的字体颜色是淡的，完全看不清楚」
// — the banner strip above the transcript is unreadable.
//
// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §3 P-3 (the ONE banner slot) / §4.1 palette
//   lib/src/ui/banner_slot.dart `_BannerFace.of`
//
// ── WHY THE SUITE WAS GREEN WHILE THE BANNER WAS INVISIBLE ───────────────────
//
// Eight banner tests mount this widget and every one of them asserts the
// SENTENCE (`find.text(...)`). `theme_tokens_test.dart` does measure contrast —
// but it measures TOKENS, and the blocking face was not a token: it was three
// `const Color(…)` literals inside `banner_slot.dart`, so it had one value for
// two themes and no test that could see it. Over the light canvas the
// near-white ink composited onto #F5C7CA at **1.37:1**.
//
// This file therefore measures what the widget tree actually carries, in both
// themes, for all three severities — the ink the `Text` resolved to, and the
// fill the `Container` resolved to composited over the page colour the
// production `Scaffold` uses (`chat_flow_page.dart` sets
// `backgroundColor: FlowMicColors.canvas`).
//
// ⚠️ WHAT A GREEN RUN PROVES: the colours the widget tree hands the painter
// clear the 4.5:1 AA bar. It does not prove a phone's screen, at its
// brightness, in daylight, is readable — that half belongs to the device line.
//
// REVERSE CONTROL: restoring the pre-fix literal
// (`bannerBlockingInk = Color(0xFFFFF1F2)` in `FlowMicLightColors`) turns the
// light-theme blocking row red at 1.37:1. Run recorded in the P0 report.

import 'dart:math' as math;

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

double _channel(double c) {
  final double v = c / 255.0;
  return v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
}

double _luminance(Color c) =>
    0.2126 * _channel(c.r * 255) + 0.7152 * _channel(c.g * 255) + 0.0722 * _channel(c.b * 255);

double _contrast(Color a, Color b) {
  final double hi = math.max(_luminance(a), _luminance(b));
  final double lo = math.min(_luminance(a), _luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

/// `fg` painted over `bg`. `bg` must be opaque — the caller walks up until it
/// finds one, exactly as a browser's `getComputedStyle` walk would.
Color _over(Color fg, Color bg) {
  expect(bg.a, 1.0, reason: 'the backdrop handed to _over must be opaque');
  double mix(double f, double b) => fg.a * f + (1 - fg.a) * b;
  return Color.from(
    alpha: 1.0,
    red: mix(fg.r, bg.r),
    green: mix(fg.g, bg.g),
    blue: mix(fg.b, bg.b),
  );
}

final AppStrings _s = AppStrings.of(AppLocale.zh);

BannerQueue _queueOf(BannerSeverity severity) {
  final BannerQueue q = BannerQueue();
  q.push(
    BannerItem(
      id: 'contrast-probe',
      severity: severity,
      // A hand-written sentence is fine HERE and only here: this file measures
      // colour, not wording, and every other banner test owns the mapping from
      // state to sentence.
      message: '电脑没有回应',
    ),
  );
  return q;
}

/// Mounts the real widget under the real page background and reads back the
/// two colours the tree resolved to.
Future<({Color ink, Color fill, Color page})> _measure(
  WidgetTester tester,
  BannerSeverity severity,
) async {
  // The page colour `chat_flow_page.dart` paints behind the slot. Read through
  // the same getter production reads, so a theme flip moves both together.
  final Color page = FlowMicColors.canvas;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        backgroundColor: page,
        body: BannerSlot(queue: _queueOf(severity), strings: _s),
      ),
    ),
  );
  final Scaffold scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
  expect(scaffold.backgroundColor, page);

  final Text text = tester.widget<Text>(find.text('电脑没有回应'));
  final Color? ink = text.style?.color;
  expect(ink, isNotNull, reason: 'the banner sentence must carry an explicit ink');

  // The strip itself: the one Container in this subtree that carries a
  // BoxDecoration with a fill.
  final Iterable<Container> boxes = tester
      .widgetList<Container>(find.byType(Container))
      .where((Container c) => c.decoration is BoxDecoration && (c.decoration! as BoxDecoration).color != null);
  expect(boxes.length, 1, reason: 'expected exactly one filled strip in the slot');
  final Color fill = (boxes.single.decoration! as BoxDecoration).color!;

  return (ink: ink!, fill: fill, page: page);
}

void main() {
  // Theme state is global; every test states its own and puts dark back, so no
  // test can leak a theme into the next one.
  setUp(() {
    FlowMicTheme.brightness.value = Brightness.dark;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  });

  for (final Brightness brightness in <Brightness>[Brightness.dark, Brightness.light]) {
    final String theme = brightness == Brightness.light ? 'light' : 'dark';
    for (final BannerSeverity severity in BannerSeverity.values) {
      testWidgets('$theme theme: the ${severity.name} banner reads at AA', (
        WidgetTester tester,
      ) async {
        FlowMicTheme.brightness.value = brightness;
        final ({Color ink, Color fill, Color page}) m = await _measure(tester, severity);
        final Color backdrop = _over(m.fill, m.page);
        final double ratio = _contrast(m.ink, backdrop);
        expect(
          ratio >= 4.5,
          isTrue,
          reason:
              '$theme/${severity.name}: ink ${m.ink} on $backdrop is '
              '${ratio.toStringAsFixed(2)}:1, under the 4.5:1 AA bar',
        );
      });
    }
  }

  testWidgets('the blocking ink is readable on the 「N more」 sheet too', (
    WidgetTester tester,
  ) async {
    // The overflow sheet paints a severity-coloured dot on `surface`. Same ink,
    // a different backdrop — and the pre-fix near-white measured 1.10:1 there,
    // i.e. an invisible dot on a white sheet.
    for (final Brightness brightness in <Brightness>[Brightness.dark, Brightness.light]) {
      FlowMicTheme.brightness.value = brightness;
      final double ratio = _contrast(FlowMicColors.bannerBlockingInk, FlowMicColors.surface);
      expect(
        ratio >= 4.5,
        isTrue,
        reason: 'blocking dot on surface: ${ratio.toStringAsFixed(2)}:1',
      );
    }
    // Keeps the analyzer honest about this being a widget test: the sheet's own
    // rendering is covered by banner_queue_test.dart's overflow cases.
    expect(tester.binding, isNotNull);
  });

  test('dark stays pixel-identical to the 2026-07-29 retune', () {
    FlowMicTheme.brightness.value = Brightness.dark;
    expect(FlowMicColors.bannerBlockingFill, const Color(0x59F87171));
    expect(FlowMicColors.bannerBlockingBorder, const Color(0xB3F87171));
    expect(FlowMicColors.bannerBlockingInk, const Color(0xFFFFF1F2));
    expect(FlowMicColors.bannerDegradedBorder, const Color(0x4DFBBF24));
    expect(FlowMicColors.bannerInfoBorder, const Color(0x4D818CF8));
  });
}
