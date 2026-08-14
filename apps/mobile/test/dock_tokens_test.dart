// WP8 VF-1 — the Plan A′ dock/sheet palette is pinned to the mock, value by value.
//
// SOURCES (both are the spec, in this order):
//   1. docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html — the design
//      mock. Its `.ph{…}` / `.ph.dk{…}` rules are literally the light/dark
//      columns; the per-component values (`.ptt.rec`, `.ptt.amb`, `.ptt.gry`,
//      `.sgi.on`, `.sheet`, the restore strip and appended-span inline styles)
//      are quoted in tokens.dart beside each token.
//   2. docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §1 — the
//      same table plus the rulings that resolve what the mock leaves open
//      (dark `rec`, the PTT label colour on `pri`, the prototype's doneFlash).
//
// WHY EVERY MEMBER, NOT A SPOT CHECK: the owner rejected WP7's look, and the
// acceptance for this round is a frame-by-frame comparison against those boards.
// A palette that drifted by one value would pass every mechanics test in the
// suite and still fail the only review that matters, so the whole column is
// pinned — the same discipline theme_tokens_test.dart applies to the legacy
// palette.
//
// SEAM: assigning `FlowMicTheme.brightness.value` directly is the documented
// legal test seam (tokens.dart's [FlowMicTheme] doc: production narrows through
// `setMode`, the palette-pinning tests assign the notifier). This file uses the
// same setUp/tearDown shape as theme_tokens_test.dart so neither can leak a
// theme into the other.

import 'dart:math' as math;

import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

double _linear(double c) =>
    c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();

double _luminance(Color c) =>
    0.2126 * _linear(c.r) + 0.7152 * _linear(c.g) + 0.0722 * _linear(c.b);

/// WCAG contrast ratio (1..21). Local copy of theme_tokens_test.dart's helper —
/// a test file cannot import another test file's main.
double contrast(Color a, Color b) {
  final double hi = math.max(_luminance(a), _luminance(b));
  final double lo = math.min(_luminance(a), _luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  setUp(() {
    FlowMicTheme.brightness.value = Brightness.dark;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  });

  group('FlowMicDockColors — transcribed from the mock, both columns', () {
    test('light column == the mock `.ph{…}` custom properties + light inlines', () {
      FlowMicTheme.brightness.value = Brightness.light;
      // `.ph{--bg:#F7F7FA;--panel:#FFFFFF;--ink:#1C1B22;--sub:#716E7E;
      //      --line:#E5E4EC;--pri:#4F46E5;--chipbg:#EFEEF6;…}`
      expect(FlowMicDockColors.bg, const Color(0xFFF7F7FA));
      expect(FlowMicDockColors.panel, const Color(0xFFFFFFFF));
      expect(FlowMicDockColors.ink, const Color(0xFF1C1B22));
      expect(FlowMicDockColors.sub, const Color(0xFF716E7E));
      expect(FlowMicDockColors.line, const Color(0xFFE5E4EC));
      expect(FlowMicDockColors.pri, const Color(0xFF4F46E5));
      expect(FlowMicDockColors.chipbg, const Color(0xFFEFEEF6));
      // Ink on a pri-filled face: white in light (contract §1's last row only
      // overrides the DARK side).
      expect(FlowMicDockColors.onPri, const Color(0xFFFFFFFF));
      // `.ab{…background:#DC2626}` — the recording ACCENT. (The recording bar's
      // FILL is `recFill`, pinned in the invariant group below.)
      expect(FlowMicDockColors.rec, const Color(0xFFDC2626));
      // Restore strip inline: `background:#F0FDFA;border:1px solid #99F6E4;
      // color:#0E9384`.
      expect(FlowMicDockColors.restoreBg, const Color(0xFFF0FDFA));
      expect(FlowMicDockColors.restoreBorder, const Color(0xFF99F6E4));
      expect(FlowMicDockColors.restoreText, const Color(0xFF0E9384));
      // Appended-span inline: `background:#EEF2FF`.
      expect(FlowMicDockColors.appendHighlight, const Color(0xFFEEF2FF));
      // `.sheet{…box-shadow:0 -10px 30px rgba(28,27,50,.14)}` — 28,27,50 =
      // #1C1B32, .14 × 255 ≈ 36 = 0x24. Upward offset: the sheet rises from the
      // bottom edge, so its shadow falls on what is above it.
      expect(FlowMicDockColors.sheetShadow, const <BoxShadow>[
        BoxShadow(color: Color(0x241C1B32), blurRadius: 30, offset: Offset(0, -10)),
      ]);
    });

    test('dark column == the mock `.ph.dk{…}` overrides + dark-frame inlines', () {
      FlowMicTheme.brightness.value = Brightness.dark;
      // `.ph.dk{--bg:#131318;--panel:#1B1B23;--ink:#ECEAF4;--sub:#9895A8;
      //         --line:#2B2A37;--pri:#818CF8;--chipbg:#26252F;…}`
      expect(FlowMicDockColors.bg, const Color(0xFF131318));
      expect(FlowMicDockColors.panel, const Color(0xFF1B1B23));
      expect(FlowMicDockColors.ink, const Color(0xFFECEAF4));
      expect(FlowMicDockColors.sub, const Color(0xFF9895A8));
      expect(FlowMicDockColors.line, const Color(0xFF2B2A37));
      expect(FlowMicDockColors.pri, const Color(0xFF818CF8));
      expect(FlowMicDockColors.chipbg, const Color(0xFF26252F));
      // A-D1 `<div class="ptt" style="color:#131318">` and A-D3
      // `<div class="pbtn" style="color:#131318">投递 ➤</div>` — the dark mock
      // writes the page colour onto the indigo faces, it does NOT keep white.
      expect(FlowMicDockColors.onPri, const Color(0xFF131318));
      // Contract §1 `rec` dark column (A-D2 recolours the amplitude bars and the
      // live dot inline to #F87171).
      expect(FlowMicDockColors.rec, const Color(0xFFF87171));
      expect(FlowMicDockColors.restoreBg, const Color(0xFF12302C));
      expect(FlowMicDockColors.restoreBorder, const Color(0xFF134E4A));
      expect(FlowMicDockColors.restoreText, const Color(0xFF2DD4BF));
      expect(FlowMicDockColors.appendHighlight, const Color(0xFF262A4E));
      // A-D3's sheet: inline `box-shadow:0 -10px 30px rgba(0,0,0,.5)`
      // (.5 × 255 ≈ 128 = 0x80).
      expect(FlowMicDockColors.sheetShadow, const <BoxShadow>[
        BoxShadow(color: Color(0x80000000), blurRadius: 30, offset: Offset(0, -10)),
      ]);
    });

    test('theme-invariant roles resolve to ONE value, in both themes', () {
      // The mock declares each of these once with no `.dk` override, and
      // contract §1 repeats the same value in both columns. Pinning dark ==
      // light (not just the literal) is what stops a later "dark needs its own
      // shade" edit from turning a deliberately single-valued role into a
      // two-valued one without touching this contract.
      FlowMicTheme.brightness.value = Brightness.light;
      final Color processingLight = FlowMicDockColors.processing;
      final Color recordOnlyLight = FlowMicDockColors.recordOnly;
      final Color doneFlashLight = FlowMicDockColors.doneFlash;
      final Color recFillLight = FlowMicDockColors.recFill;
      final List<BoxShadow> segShadowLight = FlowMicDockColors.segShadow;

      FlowMicTheme.brightness.value = Brightness.dark;
      expect(FlowMicDockColors.processing, processingLight);
      expect(FlowMicDockColors.recordOnly, recordOnlyLight);
      expect(FlowMicDockColors.doneFlash, doneFlashLight);
      expect(FlowMicDockColors.recFill, recFillLight);
      expect(FlowMicDockColors.segShadow, segShadowLight);

      // …and those single values are the mock's.
      expect(processingLight, const Color(0xFFD97706)); // .ptt.amb
      expect(recordOnlyLight, const Color(0xFF8B8996)); // .ptt.gry
      // `.ptt.rec{background:#DC2626}` — no `.dk` override anywhere in the
      // mock, so the dark board draws the recording BAR at the same red.
      expect(recFillLight, const Color(0xFFDC2626));
      // 原型 · 对话流.dc.html: `if(P==='flash'){pttBg='#16A34A';…}`
      expect(doneFlashLight, const Color(0xFF16A34A));
      // `.sgi.on{…box-shadow:0 1px 3px rgba(0,0,0,.14)}` — .14 × 255 ≈ 36 = 0x24.
      expect(segShadowLight, const <BoxShadow>[
        BoxShadow(color: Color(0x24000000), blurRadius: 3, offset: Offset(0, 1)),
      ]);
    });

    test('🔴 rec and recFill are TWO roles: same in light, apart in dark', () {
      // The split's whole content, stated as an assertion rather than as a
      // comment: they agree in light (both #DC2626), so a future
      // "simplification" that collapsed them would pass every light-column
      // check in this file and quietly put white 17sp/700 back on #F87171 —
      // 2.77:1, under even the 3:1 large-text bar. The dark divergence IS the
      // token; asserting only the two values would not notice the merge.
      FlowMicTheme.brightness.value = Brightness.light;
      expect(FlowMicDockColors.recFill, FlowMicDockColors.rec);

      FlowMicTheme.brightness.value = Brightness.dark;
      expect(
        FlowMicDockColors.recFill,
        isNot(FlowMicDockColors.rec),
        reason: 'the recording FILL followed the accent into #F87171 — the '
            'mock `.ptt.rec` has no .dk override, and the label on it does',
      );

      // …and the pairing that made the split necessary really is legible now:
      // the PTT recording label is white in both themes.
      for (final Brightness b in <Brightness>[Brightness.light, Brightness.dark]) {
        FlowMicTheme.brightness.value = b;
        final double ratio =
            contrast(FlowMicColors.onBrandInk, FlowMicDockColors.recFill);
        expect(
          ratio >= 4.5,
          isTrue,
          reason: 'onBrandInk on recFill ($b): ${ratio.toStringAsFixed(2)}:1',
        );
      }
    });

    test('every non-invariant role really does re-resolve on a theme flip', () {
      // Without this, a token accidentally written as a single const would still
      // pass BOTH column tests above only if its two values happened to be
      // equal — but a token whose ternary was dropped in a refactor would pass
      // one column and fail the other, which reads as a wrong value rather than
      // as a lost switch. This asserts the switching itself.
      FlowMicTheme.brightness.value = Brightness.light;
      final Map<String, Object> light = <String, Object>{
        'bg': FlowMicDockColors.bg,
        'panel': FlowMicDockColors.panel,
        'ink': FlowMicDockColors.ink,
        'sub': FlowMicDockColors.sub,
        'line': FlowMicDockColors.line,
        'pri': FlowMicDockColors.pri,
        'chipbg': FlowMicDockColors.chipbg,
        'onPri': FlowMicDockColors.onPri,
        'rec': FlowMicDockColors.rec,
        'restoreBg': FlowMicDockColors.restoreBg,
        'restoreBorder': FlowMicDockColors.restoreBorder,
        'restoreText': FlowMicDockColors.restoreText,
        'appendHighlight': FlowMicDockColors.appendHighlight,
        'sheetShadow': FlowMicDockColors.sheetShadow,
      };

      FlowMicTheme.brightness.value = Brightness.dark;
      final Map<String, Object> dark = <String, Object>{
        'bg': FlowMicDockColors.bg,
        'panel': FlowMicDockColors.panel,
        'ink': FlowMicDockColors.ink,
        'sub': FlowMicDockColors.sub,
        'line': FlowMicDockColors.line,
        'pri': FlowMicDockColors.pri,
        'chipbg': FlowMicDockColors.chipbg,
        'onPri': FlowMicDockColors.onPri,
        'rec': FlowMicDockColors.rec,
        'restoreBg': FlowMicDockColors.restoreBg,
        'restoreBorder': FlowMicDockColors.restoreBorder,
        'restoreText': FlowMicDockColors.restoreText,
        'appendHighlight': FlowMicDockColors.appendHighlight,
        'sheetShadow': FlowMicDockColors.sheetShadow,
      };

      for (final String role in light.keys) {
        expect(dark[role], isNot(light[role]), reason: '$role did not re-resolve');
      }
    });
  });

  group('FlowMicDockColors — the values the mock did NOT give us', () {
    // Three dark values are implementer-picked because the mock only draws
    // those surfaces in light and contract §1 says only 「keep the family
    // legible」. Each is taken from a pair this app has already proven, but
    // "taken from a proven pair" is a claim — these measure it.
    test('restore strip: dark ink on dark fill clears the 4.5:1 AA bar', () {
      FlowMicTheme.brightness.value = Brightness.dark;
      final double ratio =
          contrast(FlowMicDockColors.restoreText, FlowMicDockColors.restoreBg);
      expect(
        ratio >= 4.5,
        isTrue,
        reason: 'restoreText on restoreBg (dark): ${ratio.toStringAsFixed(2)}:1',
      );
    });

    test('restore strip: the LIGHT pair is the mock\'s own, and it is 3.64:1', () {
      // 🔴 Deliberately NOT a 4.5:1 assertion, and that is the finding rather
      // than a lowered bar: #0E9384 on #F0FDFA measures 3.64:1 — over the 3:1
      // large-text bar, under the 4.5:1 body bar. Both values are transcribed
      // from the mock's inline style, and this card has no authority to retune
      // the spec, so the fact is pinned where it can be read instead of being
      // quietly "fixed" into a colour the design never chose.
      FlowMicTheme.brightness.value = Brightness.light;
      final double ratio =
          contrast(FlowMicDockColors.restoreText, FlowMicDockColors.restoreBg);
      expect(ratio, closeTo(3.64, 0.01));
      expect(ratio >= 3.0, isTrue, reason: 'still clears the large-text bar');
    });

    test('append highlight: ink stays readable over the wash in both themes', () {
      for (final Brightness b in <Brightness>[Brightness.light, Brightness.dark]) {
        FlowMicTheme.brightness.value = b;
        final double ratio =
            contrast(FlowMicDockColors.ink, FlowMicDockColors.appendHighlight);
        expect(
          ratio >= 4.5,
          isTrue,
          reason: 'ink on appendHighlight ($b): ${ratio.toStringAsFixed(2)}:1',
        );
      }
    });
  });

  group('FlowMicDockColors is additive — the legacy palette is a different thing', () {
    test('the dock palette does not silently equal FlowMicColors', () {
      // The whole reason this class exists instead of a retune: the timeline and
      // top bar keep reading FlowMicColors and must render byte-identically
      // (contract §0 / §3). If someone later "simplifies" these getters into
      // aliases of the legacy palette, the dock stops matching the mock — and
      // every existing widget test would still be green, because none of them
      // looks at the dock's colours. (theme_tokens_test.dart is the other half:
      // it pins the legacy values themselves.)
      //
      // ⚠️ `panel` is deliberately absent from this loop: in LIGHT the mock's
      // panel and the legacy `surface` are both pure #FFFFFF, so a
      // non-equality assertion on it would be false. That coincidence is
      // exactly why tokens.dart writes its own literal instead of aliasing —
      // two roles that agree today are still two roles.
      for (final Brightness b in <Brightness>[Brightness.light, Brightness.dark]) {
        FlowMicTheme.brightness.value = b;
        expect(FlowMicDockColors.bg, isNot(FlowMicColors.canvas), reason: '$b bg');
        expect(FlowMicDockColors.ink, isNot(FlowMicColors.t1), reason: '$b ink');
        expect(FlowMicDockColors.sub, isNot(FlowMicColors.t2), reason: '$b sub');
        expect(FlowMicDockColors.line, isNot(FlowMicColors.line), reason: '$b line');
      }
      // The one place it IS an equality, stated rather than left to be
      // rediscovered as a bug: dark panel and the legacy dark surface differ,
      // light panel and light surface do not.
      FlowMicTheme.brightness.value = Brightness.light;
      expect(FlowMicDockColors.panel, FlowMicColors.surface);
      FlowMicTheme.brightness.value = Brightness.dark;
      expect(FlowMicDockColors.panel, isNot(FlowMicColors.surface));
    });
  });
}
