// WP8 VF-2 — the Plan A′ dock's RENDERED faces, pinned to the mock, in BOTH
// themes.
//
// SOURCES (both are the spec, in this order):
//   1. docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html — frames
//      A-01 (idle · direct), A-02 (idle · manual + the blue notice chip),
//      A-10 (disconnected), A-11 (record-only), A-D1 (dark idle). The CSS
//      rules quoted per case are that file's, verbatim.
//   2. docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §0 D1/D2/
//      D10 (the rejected-delta list) and §2 「Dock」.
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM dock_tokens_test.dart ───────────────
// That file pins the PALETTE (「`FlowMicDockColors.pri` is #4F46E5」). This one
// pins the WIRING (「the idle PTT bar is filled with `pri`」). Both are needed
// and neither implies the other: WP7 shipped a dock whose every token was
// available and whose widgets did not read them, and every palette test in the
// repo was green while the owner was rejecting the screen. The acceptance for
// this round is a frame-by-frame comparison against the boards, so what has to
// be asserted is what the WIDGET resolves, not what the class returns.
//
// 🔴 Every colour assertion goes through the TOKEN, never a re-typed hex. A hex
// here would be a second copy of a value dock_tokens_test.dart already owns,
// and the two copies would drift the first time the mock is re-read.
//
// SEAM: assigning `FlowMicTheme.brightness.value` directly is the documented
// legal test seam (tokens.dart's [FlowMicTheme] doc). Same setUp/tearDown shape
// as dock_tokens_test.dart so neither file can leak a theme into the other.
//
// ── REVERSE CONTROLS (both run, both seen red, both reverted) ────────────────
// (a) Putting the `'$numeral '` prefix back in `ModeSegmentedControl._segment`
//     turns 「the segments print the WORD ALONE」 red.
// (b) Giving `SendPolicyChip`'s manual face the outlined treatment back
//     (transparent fill + pri ink, i.e. the direct face) turns 「manual is a
//     FILLED pri chip with onPri ink」 red.
// Both captured outputs are quoted verbatim in the VF-2 return report.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
// `SendPolicyChip` lives in compose_buffer_row.dart, which is a `part of`
// compose_band.dart — the library, not the part file, is what an importer can
// name.
import 'package:flowmic/src/ui/compose_band.dart' show SendPolicyChip;
import 'package:flowmic/src/ui/mode_chip.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

Widget _wrap(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

/// The decoration of the FIRST `Container` under [f].
///
/// Null is a legal answer and a meaningful one: two of the three policy-chip
/// faces and every unselected segment paint NO fill, and 「no decoration」 is
/// how that is spelled (a transparent literal would be a colour decision where
/// the mock makes none).
BoxDecoration? _deco(WidgetTester tester, Finder f) {
  final Container c = tester.widget<Container>(
    find.descendant(of: f, matching: find.byType(Container)).first,
  );
  return c.decoration as BoxDecoration?;
}

/// The decoration of the `Container` the finder points AT (not under it) —
/// `ptt.bar` and `compose.dock` are keys ON their Containers, not on wrappers.
BoxDecoration? _decoAt(WidgetTester tester, Finder f) =>
    tester.widget<Container>(f).decoration as BoxDecoration?;

Color? _fill(WidgetTester tester, Finder f) => _deco(tester, f)?.color;

/// The style of the FIRST `Text` under [f].
TextStyle? _textStyle(WidgetTester tester, Finder f) => tester
    .widget<Text>(find.descendant(of: f, matching: find.byType(Text)).first)
    .style;

Finder _seg(FlowMode m) =>
    find.byKey(ValueKey<String>('compose.mode.${m.name}'));
final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));
final Finder _bar = find.byKey(const ValueKey<String>('ptt.bar'));
final Finder _dock = find.byKey(const ValueKey<String>('compose.dock'));

/// Runs [body] once per theme, naming which one failed.
Future<void> _bothThemes(
  Future<void> Function(Brightness b) body,
) async {
  for (final Brightness b in <Brightness>[Brightness.light, Brightness.dark]) {
    FlowMicTheme.brightness.value = b;
    await body(b);
  }
}

Future<ChatController> _pumpPage(
  WidgetTester tester, {
  double width = 360,
  double height = 780,
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await controller.session.dispose();
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return controller;
}

void main() {
  setUp(() {
    FlowMicTheme.brightness.value = Brightness.dark;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  });

  group('mode segmented control — contract §0 D1', () {
    testWidgets('the container is a chipbg pill and the ACTIVE segment is the '
        'panel one, in both themes', (WidgetTester tester) async {
      await _bothThemes((Brightness b) async {
        await tester.pumpWidget(
          _wrap(
            ModeSegmentedControl(
              mode: FlowMode.translate,
              strings: _zh,
              onSelect: (FlowMode _) {},
            ),
          ),
        );
        // `.seg{background:var(--chipbg);border-radius:99px}`
        expect(
          _fill(tester, find.byType(ModeSegmentedControl)),
          FlowMicDockColors.chipbg,
          reason: '$b: the segmented container lost the mock\'s chipbg pill',
        );
        // `.sgi.on{background:var(--panel);color:var(--ink);font-weight:600;
        //          box-shadow:0 1px 3px rgba(0,0,0,.14)}`
        final BoxDecoration? on = _deco(tester, _seg(FlowMode.translate));
        expect(on?.color, FlowMicDockColors.panel, reason: '$b active fill');
        expect(
          on?.boxShadow,
          FlowMicDockColors.segShadow,
          reason: '$b: the active segment lost its lift',
        );
        expect(
          _textStyle(tester, _seg(FlowMode.translate))?.color,
          FlowMicDockColors.ink,
          reason: '$b active ink',
        );
        // `.sgi` (inactive): sub ink, and NO fill at all.
        expect(
          _deco(tester, _seg(FlowMode.realtime)),
          isNull,
          reason: '$b: an unselected segment painted a fill — the mock gives '
              'it none, so there is no colour there for a token to name',
        );
        expect(
          _textStyle(tester, _seg(FlowMode.realtime))?.color,
          FlowMicDockColors.sub,
          reason: '$b inactive ink',
        );
      });
    });

    testWidgets('🔴 the segments print the WORD ALONE — no ①②③ (contract §0 '
        'D1)', (WidgetTester tester) async {
      // REVERSE CONTROL (a), run red then reverted: restoring the
      // `'$numeral '` prefix fails this case by name.
      await tester.pumpWidget(
        _wrap(
          ModeSegmentedControl(
            mode: FlowMode.realtime,
            strings: _zh,
            onSelect: (FlowMode _) {},
          ),
        ),
      );
      // Positive control FIRST: the words really are on screen, so the
      // findsNothing below is about the numerals and not about an empty tree.
      for (final FlowMode m in kModeOrder) {
        expect(
          find.text(_zh.modeLabel(m)),
          findsOneWidget,
          reason: '${m.name}: the bare catalogue word is not painted — either '
              'the numerals came back, or the label stopped being the label',
        );
      }
      for (final String numeral in <String>['①', '②', '③']) {
        expect(find.textContaining(numeral), findsNothing);
      }
    });
  });

  group('policy chip — contract §0 D2', () {
    testWidgets('🔴 manual is a FILLED pri chip with onPri ink; direct is the '
        'outlined one — both themes', (WidgetTester tester) async {
      // REVERSE CONTROL (b), run red then reverted: giving the manual face the
      // outlined treatment (no fill, pri ink) fails the two manual lines here.
      await _bothThemes((Brightness b) async {
        // A-02: `<span class="strat" style="background:var(--pri);color:#fff">`
        await tester.pumpWidget(
          _wrap(
            SendPolicyChip(
              policy: SendPolicy.manual,
              strings: _zh,
              onTap: () {},
            ),
          ),
        );
        expect(_fill(tester, _policy), FlowMicDockColors.pri, reason: '$b');
        expect(
          _textStyle(tester, _policy)?.color,
          FlowMicDockColors.onPri,
          reason: '$b: manual ink must be the on-pri token — white in light, '
              'the page colour in dark (A-D1/A-D3 write that inline)',
        );

        // A-01: bare `.strat` — pri text, 1dp pri border, NO fill.
        await tester.pumpWidget(
          _wrap(
            SendPolicyChip(
              policy: SendPolicy.direct,
              strings: _zh,
              onTap: () {},
            ),
          ),
        );
        expect(
          _fill(tester, _policy),
          isNull,
          reason: '$b: the direct chip grew a fill — the mock leaves it open',
        );
        expect(
          _textStyle(tester, _policy)?.color,
          FlowMicDockColors.pri,
          reason: '$b direct ink',
        );
        expect(
          (_deco(tester, _policy)?.border as Border?)?.top.color,
          FlowMicDockColors.pri,
          reason: '$b direct border',
        );
      });
    });

    testWidgets('A-11 muted: the record-only face is neutral AND STILL '
        'TAPPABLE', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(
        _wrap(
          SendPolicyChip(
            policy: SendPolicy.manual,
            strings: _zh,
            muted: true,
            onTap: () => taps++,
          ),
        ),
      );
      // `style="color:var(--sub);border-color:var(--line)"` — and the base
      // class's fill, i.e. none, wins back over the manual inline.
      expect(_fill(tester, _policy), isNull);
      expect(_textStyle(tester, _policy)?.color, FlowMicDockColors.sub);
      expect(
        (_deco(tester, _policy)?.border as Border?)?.top.color,
        FlowMicDockColors.line,
      );
      // 🔴 The half that makes this a face and not a disabled state: a muted
      // chip that swallowed its tap would be the fabricated-disabled lie, and
      // the policy it sets is still real (it is what the NEXT utterance uses
      // once a PC is back).
      await tester.tap(_policy);
      await tester.pump();
      expect(taps, 1, reason: '🔴 the muted chip went inert — muting is paint');
    });

    testWidgets('the ⇄ is a LAYOUT glyph: painted, but never announced', (
      WidgetTester tester,
    ) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(
        _wrap(
          SendPolicyChip(
            policy: SendPolicy.direct,
            strings: _zh,
            onTap: () {},
          ),
        ),
      );
      expect(find.text('${_zh.sendPolicyDirect} ⇄'), findsOneWidget);
      // …and the accessible name is the bare sentence: a screen reader reading
      // out a symbol name is worse than no glyph at all.
      expect(
        find.bySemanticsLabel(
          '${_zh.sendPolicyDirect} · ${_zh.sendPolicyDirectHint}',
        ),
        findsOneWidget,
      );
      handle.dispose();
    });
  });

  group('PTT bar — contract §0 D10', () {
    testWidgets('idle is pri-filled, disabled is chipbg — both themes', (
      WidgetTester tester,
    ) async {
      await _bothThemes((Brightness b) async {
        // `.ptt{background:var(--pri)}`
        await tester.pumpWidget(
          _wrap(PttBar(visual: PttVisual.idle, strings: _zh)),
        );
        expect(
          _decoAt(tester, _bar)?.color,
          FlowMicDockColors.pri,
          reason: '$b idle',
        );
        expect(
          _textStyle(tester, _bar)?.color,
          FlowMicDockColors.onPri,
          reason: '$b: the idle label must ride the on-pri token',
        );
        // `.ptt.dis{background:var(--chipbg);color:var(--sub)}`
        await tester.pumpWidget(
          _wrap(PttBar(visual: PttVisual.disabled, strings: _zh)),
        );
        expect(
          _decoAt(tester, _bar)?.color,
          FlowMicDockColors.chipbg,
          reason: '$b disabled',
        );
        expect(
          _textStyle(tester, _bar)?.color,
          FlowMicDockColors.sub,
          reason: '$b disabled ink',
        );

        // `.ptt.rec{background:#DC2626}` with no `.dk` override ⇒ the recording
        // BAR is the same red in both themes (`recFill`), while the strip's
        // bars/timer keep the lightening `rec`. Pinned in BOTH themes here
        // because the bug the split fixes only shows in one of them.
        await tester.pumpWidget(
          _wrap(PttBar(visual: PttVisual.recording, strings: _zh)),
        );
        expect(
          _decoAt(tester, _bar)?.color,
          FlowMicDockColors.recFill,
          reason: '$b recording fill',
        );
        expect(
          _textStyle(tester, _bar)?.color,
          FlowMicColors.onBrandInk,
          reason: '$b recording ink stays white on the red',
        );
        // Leave the pulse ticker somewhere the binding can dispose cleanly —
        // `pumpAndSettle` would never settle on a repeating animation.
        await tester.pumpWidget(
          _wrap(PttBar(visual: PttVisual.idle, strings: _zh)),
        );
      });
    });

    testWidgets('no face carries a shadow any more (the mock draws none, and '
        'dark must not gain weight)', (WidgetTester tester) async {
      await _bothThemes((Brightness b) async {
        for (final PttVisual v in PttVisual.values) {
          await tester.pumpWidget(_wrap(PttBar(visual: v, strings: _zh)));
          expect(
            _decoAt(tester, _bar)?.boxShadow,
            isNull,
            reason: '$b/${v.name}: a glow came back — contract §1 ends with '
                '「no heavier shadows in dark; hierarchy via panel/line」',
          );
        }
      });
    });
  });

  group('dock container + the policy flash', () {
    testWidgets('the dock is a panel with a line top border (both themes)', (
      WidgetTester tester,
    ) async {
      // ⚠️ The page is pumped INSIDE the loop, not once outside it. The dock
      // palette resolves at build time and nothing on this page listens to
      // `FlowMicTheme.brightness`, so flipping the notifier over a tree that is
      // already built proves nothing — it would read back the theme the FIRST
      // pump baked in, and the case would silently only ever test one column.
      await _bothThemes((Brightness b) async {
        final ChatController controller = await _pumpPage(tester);
        final BoxDecoration deco = _decoAt(tester, _dock)!;
        expect(deco.color, FlowMicDockColors.panel, reason: '$b dock fill');
        expect(
          (deco.border! as Border).top.color,
          FlowMicDockColors.line,
          reason: '$b dock top border',
        );
        controller.session.debugStopIdlePresencePoll();
      });
    });

    testWidgets('🔴 the 800ms policy notice floats OVER THE TIMELINE — above '
        'the dock\'s top border, centred, and inside the screen', (
      WidgetTester tester,
    ) async {
      // Mock A-02 draws this notice as a timeline row (`<div class="evt"
      // style="background:var(--pri);color:#fff">`), self-centred, right at the
      // timeline's lower edge. WP7 hung it BELOW the chip instead; this case is
      // what makes the move real rather than a comment.
      // ⚠️ The criterion is the RENDERED rect, not the widget's parameters —
      // the notice lives in an OverlayPortal now, so 「where does it land」 is
      // a question only the laid-out tree can answer.
      final ChatController controller = await _pumpPage(tester);
      expect(controller.sendPolicy, SendPolicy.direct);

      await tester.tap(_policy);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 10));

      final Finder toast = find.textContaining(_zh.sendPolicyManualHint);
      expect(
        toast,
        findsOneWidget,
        reason: 'the notice did not appear at all — the rest of this case '
            'would then be vacuously true',
      );
      final Rect pill = tester.getRect(toast);
      final Rect dock = tester.getRect(_dock);

      expect(
        pill.bottom,
        lessThan(dock.top),
        reason: '🔴 the notice is INSIDE the dock (bottom ${pill.bottom} vs '
            'dock top ${dock.top}) — A-02 puts it on the timeline',
      );
      expect(pill.top, greaterThanOrEqualTo(0), reason: 'clipped off the top');
      expect(pill.left, greaterThanOrEqualTo(0), reason: 'off the left edge');
      expect(pill.right, lessThanOrEqualTo(360), reason: 'off the right edge');
      expect(
        pill.center.dx,
        closeTo(180, 1),
        reason: 'the notice is not centred across the band — it inherited the '
            'chip\'s right alignment again',
      );

      // …and it still leaves entirely (V2-04: the switch leaves no standing
      // UI). Same 800ms hold + 200ms fade as before the move.
      await tester.pump(const Duration(milliseconds: 900));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining(_zh.sendPolicyManualHint), findsNothing);
      controller.session.debugStopIdlePresencePoll();
    });
  });
}
