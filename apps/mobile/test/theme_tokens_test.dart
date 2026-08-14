// V2-07.3 — guards for the switchable-theme skeleton.
//
// (1) DARK IS FROZEN: every FlowMicColors getter must resolve to the exact
//     hex of the frozen demo palette (58f44c3) under the default dark theme.
//     This is the executable proof of the card's core criterion — "dark stays
//     pixel-identical" — pinning ALL 27 tokens, not a spot check.
// (2) THE SWITCH WORKS: assigning FlowMicTheme.brightness re-resolves every
//     getter to the light palette, and switching back restores dark.
// (3) LIGHT STAYS READABLE: WCAG relative-luminance contrast ≥ 4.5:1 (AA
//     body text) for every text-role colour on the fills it is painted on,
//     and every accent keeps its dark-theme hue family.

import 'dart:math' as math;

import 'package:flowmic/src/ui/tokens.dart';
// 2026-08-01: was `package:flutter/widgets.dart` — the new ChannelBadge test below
// needs `Icons`/`MaterialApp` (material.dart is widgets.dart's superset).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

double _linear(double c) =>
    c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();

double _luminance(Color c) =>
    0.2126 * _linear(c.r) + 0.7152 * _linear(c.g) + 0.0722 * _linear(c.b);

/// WCAG contrast ratio (1..21).
double contrast(Color a, Color b) {
  final double hi = math.max(_luminance(a), _luminance(b));
  final double lo = math.min(_luminance(a), _luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

void expectReadable(Color ink, Color fill, String what) {
  final double ratio = contrast(ink, fill);
  expect(
    ratio >= 4.5,
    isTrue,
    reason: '$what: ${ratio.toStringAsFixed(2)}:1 is under the 4.5:1 AA bar',
  );
}

void main() {
  // Global theme state is shared across these tests; every test starts dark
  // and any switch is undone, so no test can leak a theme into the next one
  // (and other test files run in their own isolates regardless).
  setUp(() {
    FlowMicTheme.brightness.value = Brightness.dark;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  });

  test('default theme is dark', () {
    expect(FlowMicTheme.brightness.value, Brightness.dark);
    expect(FlowMicTheme.isLight, isFalse);
  });

  test('dark palette is pixel-identical to the frozen demo values', () {
    // Every literal below is the PRE-REFACTOR value of the same-named token,
    // lifted verbatim from the old FlowMicColors (frozen demo 58f44c3).
    expect(FlowMicColors.brand, const Color(0xFF818CF8));
    expect(FlowMicColors.brandDeep, const Color(0xFF4F46E5));
    expect(FlowMicColors.brandSoft, const Color(0x24818CF8));
    expect(FlowMicColors.teal, const Color(0xFF2DD4BF));
    expect(FlowMicColors.tealSoft, const Color(0x212DD4BF));
    expect(FlowMicColors.amber, const Color(0xFFFBBF24));
    expect(FlowMicColors.amberSoft, const Color(0x21FBBF24));
    expect(FlowMicColors.red, const Color(0xFFF87171));
    expect(FlowMicColors.redSoft, const Color(0x24F87171));
    expect(FlowMicColors.green, const Color(0xFF4ADE80));
    expect(FlowMicColors.greenSoft, const Color(0x214ADE80));
    expect(FlowMicColors.slate, const Color(0xFF94A3B8));
    expect(FlowMicColors.slateSoft, const Color(0x2994A3B8));
    expect(FlowMicColors.canvas, const Color(0xFF0B0D14));
    expect(FlowMicColors.body, const Color(0xFF06080F));
    expect(FlowMicColors.surface, const Color(0xFF12151F));
    expect(FlowMicColors.surface2, const Color(0xFF181C2B));
    expect(FlowMicColors.line, const Color(0xFF232839));
    expect(FlowMicColors.t1, const Color(0xFFE6E9F2));
    expect(FlowMicColors.t2, const Color(0xFF9AA1B5));
    expect(FlowMicColors.t3, const Color(0xFF5C6377));
    expect(FlowMicColors.pttIdle, <Color>[const Color(0xFF5B54E8), const Color(0xFF7C74F2)]);
    expect(FlowMicColors.pttRec, <Color>[const Color(0xFFDC4C4C), const Color(0xFFF87171)]);
    expect(FlowMicColors.pttNoted, <Color>[const Color(0xFF4B5163), const Color(0xFF5C6377)]);
    // The three aliases kept their equations: processing = amber, done =
    // green, on-light ink = body.
    expect(FlowMicColors.pttProcessingBg, FlowMicColors.amber);
    expect(FlowMicColors.pttDoneBg, FlowMicColors.green);
    expect(FlowMicColors.pttOnLightInk, FlowMicColors.body);
  });

  test('switching to light re-resolves every getter; switching back restores', () {
    expect(FlowMicColors.brand, const Color(0xFF818CF8));
    FlowMicTheme.brightness.value = Brightness.light;
    expect(FlowMicTheme.isLight, isTrue);
    expect(FlowMicColors.brand, const Color(0xFF4F46E5));
    expect(FlowMicColors.canvas, const Color(0xFFF4F5FA));
    expect(FlowMicColors.t1, const Color(0xFF1A1E2E));
    expect(FlowMicColors.red, const Color(0xFFB91C1C));
    // Branded action faces deliberately keep the dark gradients (white ink).
    expect(FlowMicColors.pttIdle, FlowMicDarkColors.pttIdle);
    expect(FlowMicColors.pttRec, FlowMicDarkColors.pttRec);
    // …while noted pales, because its ink is t1.
    expect(FlowMicColors.pttNoted, isNot(FlowMicDarkColors.pttNoted));
    // Alias equations survive the switch…
    expect(FlowMicColors.pttProcessingBg, FlowMicColors.amber);
    expect(FlowMicColors.pttDoneBg, FlowMicColors.green);
    // …except on-light ink, which inverts (documented in tokens.dart).
    expect(FlowMicColors.pttOnLightInk, const Color(0xFFFFFFFF));
    FlowMicTheme.brightness.value = Brightness.dark;
    expect(FlowMicColors.brand, const Color(0xFF818CF8));
    expect(FlowMicColors.canvas, const Color(0xFF0B0D14));
  });

  test('light palette keeps ≥4.5:1 on every text/fill pairing', () {
    FlowMicTheme.brightness.value = Brightness.light;
    final Color canvas = FlowMicColors.canvas;
    final Color surface = FlowMicColors.surface;
    final Color surface2 = FlowMicColors.surface2;
    // Text roles on the three fills they are painted on.
    for (final (String name, Color ink) in <(String, Color)>[
      ('t1', FlowMicColors.t1),
      ('t2', FlowMicColors.t2),
      ('t3', FlowMicColors.t3),
    ]) {
      expectReadable(ink, canvas, '$name on canvas');
      expectReadable(ink, surface, '$name on surface');
      expectReadable(ink, surface2, '$name on surface2');
    }
    // Status-word accents on surface (the 「已注入」「未注入」 badges' text).
    for (final (String name, Color ink) in <(String, Color)>[
      ('brand', FlowMicColors.brand),
      ('teal', FlowMicColors.teal),
      ('amber', FlowMicColors.amber),
      ('red', FlowMicColors.red),
      ('green', FlowMicColors.green),
      ('slate', FlowMicColors.slate),
    ]) {
      expectReadable(ink, surface, '$name on surface');
    }
    // Badge text on its own soft fill composited over surface.
    expectReadable(FlowMicColors.brand, Color.alphaBlend(FlowMicColors.brandSoft, surface), 'brand on brandSoft');
    expectReadable(FlowMicColors.teal, Color.alphaBlend(FlowMicColors.tealSoft, surface), 'teal on tealSoft');
    expectReadable(FlowMicColors.amber, Color.alphaBlend(FlowMicColors.amberSoft, surface), 'amber on amberSoft');
    expectReadable(FlowMicColors.red, Color.alphaBlend(FlowMicColors.redSoft, surface), 'red on redSoft');
    expectReadable(FlowMicColors.green, Color.alphaBlend(FlowMicColors.greenSoft, surface), 'green on greenSoft');
    expectReadable(FlowMicColors.slate, Color.alphaBlend(FlowMicColors.slateSoft, surface), 'slate on slateSoft');
    // PTT solid faces carry the on-light ink; noted carries t1.
    expectReadable(FlowMicColors.pttOnLightInk, FlowMicColors.pttProcessingBg, 'ink on processing');
    expectReadable(FlowMicColors.pttOnLightInk, FlowMicColors.pttDoneBg, 'ink on done');
    expectReadable(FlowMicColors.t1, FlowMicColors.pttNoted.first, 't1 on pttNoted[0]');
    expectReadable(FlowMicColors.t1, FlowMicColors.pttNoted.last, 't1 on pttNoted[1]');
    // The hard-coded white ink on the brandDeep toggle (compose_band).
    expectReadable(const Color(0xFFFFFFFF), FlowMicColors.brandDeep, 'white on brandDeep');
  });

  test('light palette keeps every accent in its dark hue family', () {
    double hue(Color c) => HSVColor.fromColor(c).hue;
    final Map<String, (Color dark, Color light, double min, double max)> roles =
        <String, (Color, Color, double, double)>{
      'brand': (FlowMicDarkColors.brand, FlowMicLightColors.brand, 220, 260),
      'teal': (FlowMicDarkColors.teal, FlowMicLightColors.teal, 155, 185),
      'amber': (FlowMicDarkColors.amber, FlowMicLightColors.amber, 20, 50),
      'red': (FlowMicDarkColors.red, FlowMicLightColors.red, 0, 5),
      'green': (FlowMicDarkColors.green, FlowMicLightColors.green, 130, 160),
      'slate': (FlowMicDarkColors.slate, FlowMicLightColors.slate, 205, 230),
    };
    for (final MapEntry<String, (Color, Color, double, double)> e in roles.entries) {
      final (Color dark, Color light, double min, double max) = e.value;
      expect(hue(dark), inInclusiveRange(min, max), reason: '${e.key} dark hue');
      expect(hue(light), inInclusiveRange(min, max), reason: '${e.key} light hue');
    }
  });

  // ── 2026-08-01 channel visual identity (owner: 颜色+图标组合，不能只靠颜色；
  //    一处定义，全产品统一) ─────────────────────────────────────────────────────
  group('FlowMicChannelColors — byte-identical with desktop tokens.css', () {
    test('pins the exact hex this file header promises desktop matches', () {
      // apps/desktop/src/styles/tokens.css: --channel-lan-ink / --channel-lan-soft /
      // --channel-cloud-ink / --channel-cloud-soft carry these SAME literals.
      FlowMicTheme.brightness.value = Brightness.light;
      expect(FlowMicChannelColors.lanInk, const Color(0xFF0F766E));
      expect(FlowMicChannelColors.lanSoft, const Color(0xFFE6FAF7));
      expect(FlowMicChannelColors.cloudInk, const Color(0xFF4F46E5));
      expect(FlowMicChannelColors.cloudSoft, const Color(0xFFEEF0FE));

      FlowMicTheme.brightness.value = Brightness.dark;
      expect(FlowMicChannelColors.lanInk, const Color(0xFF2DD4BF));
      expect(FlowMicChannelColors.lanSoft, const Color(0xFF12302C));
      expect(FlowMicChannelColors.cloudInk, const Color(0xFF818CF8));
      expect(FlowMicChannelColors.cloudSoft, const Color(0xFF262A4E));
    });

    test('every ink/soft pair clears the 4.5:1 AA bar, both themes', () {
      for (final Brightness b in <Brightness>[Brightness.light, Brightness.dark]) {
        FlowMicTheme.brightness.value = b;
        expectReadable(FlowMicChannelColors.lanInk, FlowMicChannelColors.lanSoft, 'lan ink on lan soft ($b)');
        expectReadable(FlowMicChannelColors.cloudInk, FlowMicChannelColors.cloudSoft, 'cloud ink on cloud soft ($b)');
      }
      FlowMicTheme.brightness.value = Brightness.dark;
    });

    test('lan and cloud are genuinely different colours in both themes (not one hue twice)', () {
      for (final Brightness b in <Brightness>[Brightness.light, Brightness.dark]) {
        FlowMicTheme.brightness.value = b;
        expect(FlowMicChannelColors.lanInk, isNot(FlowMicChannelColors.cloudInk));
      }
      FlowMicTheme.brightness.value = Brightness.dark;
    });
  });

  group('ChannelBadge — icon differs, not just colour', () {
    testWidgets('lan renders Icons.wifi, cloud renders Icons.cloud_outlined — two real shapes', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Column(
            children: <Widget>[
              ChannelBadge(label: 'lan', cloud: false),
              ChannelBadge(label: 'cloud', cloud: true),
            ],
          ),
        ),
      );
      // Never the SAME icon recoloured: if a regression swapped both badges to the
      // same IconData, ONE of these two would find 2 widgets and the other 0 —
      // "one each" is only possible when the two shapes are genuinely different.
      expect(find.byIcon(Icons.wifi), findsOneWidget);
      expect(find.byIcon(Icons.cloud_outlined), findsOneWidget);
    });
  });
}
