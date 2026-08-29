// 🔴 FB-4 global type-size three steps (owner 2026-08-06 ruling D3) — mechanism test.
//
// Provenance: `docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md` §5 / §6.
//
// ── What this file must prove, and why none of the proofs can be skipped ────
// ① it is persisted (the weakest one; **zero proving power** on its own, see
//    the warning below);
// ② 🔴 the selected step **really reaches `MediaQuery.textScaler` in the
//    render tree**;
// ③ 🔴 it is **multiplied on top of the system scale**, not a replacement
//    of the system scale;
// ④ 🔴 「大」 and today's behaviour have **zero difference** (regression
//    assertion);
// ⑤ one no-overflow assertion each for the PTT area / header / status
//    badge, under all three steps;
// ⑥ all four languages present;
// ⑦ production really hung that layer (`main.dart`'s structural guard).
//
// ── 🔴 0.3.28: THE LADDER GREW UPWARD, AND ⑤ HAD TO BE REDONE ──────────────
//
// The list above is kept as written; only the counts moved. There are now
// **five** rungs (`xlarge` 1.15 / `xxlarge` 1.30 appended) and **nine**
// languages. Almost every group here already iterated `AppTextScale.values`
// and `AppLocale.values`, so they widened for free — which is why they were
// written that way.
//
// **⑤'s status-badge case did not widen for free, and that is the point.** It
// asserted `width(step) <= width(large)` under FB-4's "only shrink" promise.
// That promise is gone, and its own failure text had already named the
// consequence ("the 'only shrink' premise is broken, every
// 'layout-direction-safe' claim on this card has to be redone"). It is redone
// in place, with the original paragraph preserved above the correction: the
// assertion is now **monotonicity in the tier order** plus **the top tier fits
// a real 411dp screen's per-script Ahem budget**. Sizing the box to the top
// tier's own intrinsic width would have been the circular version of that, and
// is called out at the site.
//
// ⚠️ What this file still does NOT prove: that 1.30 is comfortable, or that
// any of this looks right on glass. Ahem only answers "can it clip".
//
// 🔴 **Why ① must be paired with ② — this is the easiest place on this
// card to fake it.** The window brief that dispatched the card wrote
// "the new key will pass the `settings-key-drift` lint" — **that sentence
// is true, and it proves nothing**: `verify/lint/settings-key-drift.mjs`
// only recognises the `updateSetting(...)` / `readSetting(...)` call
// shape, and `lib/src/settings/app_settings.dart`'s own header writes
// "Persisted via shared_preferences (NOT the settings-store call
// pattern, so invisible to settings-key-drift)" (grep that sentence
// verbatim). ⇒ This key **sails through** that lint; it is green because
// it was never seen.
// The in-repo precedent says the same shape more plainly:
// `test/spoken_language_test.dart`'s header records "a test that only
// asserts the chip was persisted stays fully green when the setting
// never went live at all".
// ⇒ So this file's criterion lands on the **render tree**, not on the pref.
//
// ⚠️ **Ruler** (copied from the warning in
// `test/inject_verdict_note_test.dart`'s header, because it applies the
// same way; that paragraph opens with "this file does not measure real-
// device pixels", grep to find it):
// `flutter_test` uses the Ahem placeholder font, every glyph a full-em
// square, much wider than a real font. So "no overflow under Ahem ⇒ a
// real device will not overflow" holds, **the converse does not** — do
// not use this file to argue "something just fits on a real device".
// Group ⑤ asks only the "will it overflow" direction.
//
// 🔴 **Reverse control (measured execution, see the report)**: replace
// `text_scale_scope.dart`'s `data.copyWith(textScaler: ...)` with `data`
// (i.e. "persisted but not live"), groups ②③ go red immediately, while
// group ① stays fully green — which is exactly the shape the warning
// above describes. Restored, re-greened, leftover-string grep = 0.
//
// ── 🔴🔴 2026-08-27: THE PICKER BECAME A SLIDER, AND ONE ASSERTION IS
//    DELIBERATELY RETIRED ────────────────────────────────────────────────────
//
// owner ruling `docs/decisions/2026-08-27-owner-text-scale-slider.md`. On an
// English device the five chips read Small / Medium / Large / Larger /
// Largest, and owner reported 「two 'large' entries」. They were five distinct
// strings, so ⑥'s "pairwise distinct within a language" assertion was **green
// on the exact defect it exists to catch** — distinct is not the same
// property as *tellable apart*, and no set-based assertion can tell them
// apart because the confusion lives in the reader, not in the data.
//
// ⇒ The chips are one Slider, the current rung reads as a **percentage**
// (`AppTextScale.percent`, medium = 100%, derived from the real factor), and
// the five adjective strings are DELETED from the catalogue.
//
// 🔴 **The retired assertion, named rather than quietly dropped (0.2.52 §3:
// a wrong reverse control does not merely miss a defect, it writes the defect
// into the acceptance criteria).** ⑥ used to assert
// `stepNames.toSet()` has five members, with the comment "names colliding =
// the user sees two identical chips". That sentence is still true; it simply
// **was not the failure**. It is not weakened and re-kept — the strings it
// read no longer exist. What replaces it in ⑥ is the property adjectives
// never had and a percentage cannot lose: the five read-outs are **distinct
// AND strictly increasing in the tier order, in every language, because they
// are the same five numbers in every language**. ⑥ additionally asserts the
// five old keys are **gone from all nine catalogue files** — 「no adjective
// tier name is visible anywhere」 is the ruling's actual requirement, and a
// test that only stopped reading them would stay green while they still
// shipped.
//
// ⚠️ Everything ②③④⑤ measure is UNCHANGED and none of it was allowed to
// soften: the five factors, the five rungs reaching `MediaQuery.textScaler`,
// the multiplication with the system curve, the per-script overflow budgets,
// the pill's monotonicity. The ruling scoped itself to the **picker**, not to
// the rungs, and so does this file.
//
// 🔴 **②b LIVES IN ANOTHER FILE NOW**: `text_scale_picker_test.dart` (the
// wiring group, plus the row's own 320dp layout). This file went to 1,414
// lines against the 1,200 test cap, and the split is structural, not a
// deletion — `support/text_scale_rig.dart`'s header records the move and its
// diff discipline. Where the two files divide is where the ruling divided:
// **the rungs** here, **the control the user touches** there. If you are
// asking 「is the row wired at all」, that question is not answered in this
// file.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart' show SendPolicy;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flowmic/src/ui/text_scale_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/legibility.dart';
import 'support/text_scale_rig.dart';

const String kTextScaleKey = 'flowmic.pref.textScale';

// Two shims so that every case below is **character-for-character** what it was
// before the 2026-08-27 split (`support/text_scale_rig.dart`'s header carries
// the why). One line each, and the diff of that move shows no case body.
Future<AppSettingsController> _boot(Map<String, Object> initial) =>
    bootTextScale(initial);
String _pct(AppTextScale step) => textScalePct(step);

/// Pull the scaler that is **actually in effect** out of the render tree.
///
/// 🔴 The criterion is `MediaQuery.textScalerOf(context)` — the one every
/// `Text` actually asks at layout time, not a field on the controller, and
/// not the string in the pref.
class _ScalerProbe extends StatelessWidget {
  const _ScalerProbe({required this.onBuild});
  final void Function(TextScaler) onBuild;

  @override
  Widget build(BuildContext context) {
    onBuild(MediaQuery.textScalerOf(context));
    return const SizedBox.shrink();
  }
}

Future<TextScaler> _effectiveScaler(
  WidgetTester tester,
  AppSettingsController c,
) async {
  late TextScaler seen;
  await tester.pumpWidget(
    MaterialApp(
      // Same hang as main.dart: TextScaleScope lives in `builder:`, so
      // every route the Navigator pushes is under it too.
      builder: (BuildContext context, Widget? page) =>
          TextScaleScope(appSettings: c, child: page!),
      home: _ScalerProbe(onBuild: (TextScaler s) => seen = s),
    ),
  );
  return seen;
}

ChatController _chatController(FakeSocketTransport transport) {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

void main() {
  // ── ① persistence: whitelist parse + save-on-change + default = today ────
  group('① persistence (note: this group has zero proving power on its own; the criterion is in ②)', () {
    test('default is 「大」 = today\'s behaviour, and nothing is written until a choice is made', () async {
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      expect(c.textScale, AppTextScale.large);
      // After an upgrade of an old install, not a single byte changes: never
      // chosen ⇒ the key does not exist ⇒ parse falls back to 「大」.
      expect(
        SharedPreferences.getInstance().then((SharedPreferences p) =>
            p.getString(kTextScaleKey)),
        completion(isNull),
      );
    });

    test('save-on-change: one tap writes to disk, the next boot reads it back', () async {
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      int notified = 0;
      c.addListener(() => notified++);
      c.setTextScale(AppTextScale.small);
      expect(notified, 1);
      final SharedPreferences p = await SharedPreferences.getInstance();
      expect(p.getString(kTextScaleKey), 'small');

      final AppSettingsController next = AppSettingsController(prefs: p);
      await next.load();
      addTearDown(next.dispose);
      expect(next.textScale, AppTextScale.small);
    });

    test('no write and no notify when unchanged (same shape as setThemeMode)', () async {
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      int notified = 0;
      c.addListener(() => notified++);
      c.setTextScale(AppTextScale.large); // already large
      expect(notified, 0);
    });

    test('an unrecognised stored value ⇒ fall back to 「大」, never throw', () async {
      final AppSettingsController c = await _boot(<String, Object>{
        kTextScaleKey: 'gigantic',
      });
      addTearDown(c.dispose);
      expect(c.textScale, AppTextScale.large);
    });
  });

  // ── ② 🔴 the step really reaches MediaQuery.textScaler in the render tree ──
  group('② live: the selected step reaches MediaQuery.textScaler', () {
    testWidgets('each of the three steps arrives, and the numbers are the three factors owner ruled',
        (WidgetTester tester) async {
      for (final AppTextScale step in AppTextScale.values) {
        final AppSettingsController c = await _boot(<String, Object>{
          kTextScaleKey: step.name,
        });
        addTearDown(c.dispose);
        final TextScaler seen = await _effectiveScaler(tester, c);
        // 14 is one of the most common body sizes in this app (`onboarding_view._body`).
        expect(
          seen.scale(14),
          closeTo(14 * step.factor, 1e-9),
          reason: '${step.name} did not reach the render tree',
        );
      }
      // The numbers, pinned verbatim: changing a factor must be a conscious act.
      // 1.00/0.92/0.85 = owner's 2026-08-06 ruling D3; 1.15/1.30 = 0.3.28.
      expect(AppTextScale.large.factor, 1.00);
      expect(AppTextScale.medium.factor, 0.92);
      expect(AppTextScale.small.factor, 0.85);
      expect(AppTextScale.xlarge.factor, 1.15);
      expect(AppTextScale.xxlarge.factor, 1.30);
      // 🔴 The enum names ARE the storage keys (`setTextScale` writes
      // `next.name`). Pinning them here is what makes a rename go red instead
      // of silently resetting every existing user's choice to the default arm.
      expect(
        AppTextScale.values.map((AppTextScale s) => s.name).toList(),
        <String>['large', 'medium', 'small', 'xlarge', 'xxlarge'],
      );
    });

    testWidgets('🔴 the step-change itself: the controller fires, this frame switches (no restart)',
        (WidgetTester tester) async {
      // ⚠️ This case **does not answer "is that settings-page row wired"** —
      // do not let it pretend to. Its old comment wrote "what that row on
      // the settings page does is this one thing (`settings.textScale.*`
      // chip → `appSettings.setTextScale(step)`)" — that is a **comment
      // asserting behaviour elsewhere**, and that "elsewhere" had never
      // been tapped anywhere under `test/` (anti-façade ④).
      // The wiring criterion is ②b below: real page, real keys.
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      late TextScaler seen;
      await tester.pumpWidget(
        MaterialApp(
          builder: (BuildContext context, Widget? page) =>
              TextScaleScope(appSettings: c, child: page!),
          home: _ScalerProbe(onBuild: (TextScaler s) => seen = s),
        ),
      );
      expect(seen.scale(10), closeTo(10.0, 1e-9));

      c.setTextScale(AppTextScale.small);
      await tester.pump();
      expect(
        seen.scale(10),
        closeTo(8.5, 1e-9),
        reason: 'this frame did not switch after the tap ⇒ "save-on-change" only did the "save"',
      );
    });
  });

  // ── ③ 🔴 **multiplied** with the system scale, not a replacement ──────────
  group('③ system accessibility scale must not be swallowed', () {
    testWidgets('system 1.5 × step 0.85 ⇒ 1.275, neither 0.85 nor 1.5',
        (WidgetTester tester) async {
      // A setting a real user would have: poor vision, system type size turned up.
      tester.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      final AppSettingsController c = await _boot(<String, Object>{
        kTextScaleKey: 'small',
      });
      addTearDown(c.dispose);
      final TextScaler seen = await _effectiveScaler(tester, c);

      expect(seen.scale(20), closeTo(20 * 1.5 * 0.85, 1e-6));
      // Two negative controls, each pinning one wrong implementation:
      expect(
        seen.scale(20),
        isNot(closeTo(20 * 0.85, 1e-6)),
        reason: 'the step replaced the system scale — it swallowed the user\'s accessibility setting',
      );
      expect(
        seen.scale(20),
        isNot(closeTo(20 * 1.5, 1e-6)),
        reason: 'the step never took effect',
      );
    });

    testWidgets('system scale changes, step does not ⇒ the result follows the system (not a frozen snapshot)',
        (WidgetTester tester) async {
      final AppSettingsController c = await _boot(<String, Object>{
        kTextScaleKey: 'medium',
      });
      addTearDown(c.dispose);
      tester.platformDispatcher.textScaleFactorTestValue = 1.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      expect((await _effectiveScaler(tester, c)).scale(10), closeTo(9.2, 1e-6));

      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      expect((await _effectiveScaler(tester, c)).scale(10), closeTo(18.4, 1e-6));
    });
  });

  // ── ④ 🔴 「大」 = today's behaviour, zero-difference regression assertion ──
  group('④ the large step is bitwise identical to "this layer is not there"', () {
    testWidgets('under any system scale, the large-step computed size is **exactly equal** to what the system itself computes',
        (WidgetTester tester) async {
      for (final double systemFactor in <double>[1.0, 0.85, 1.3, 2.0]) {
        tester.platformDispatcher.textScaleFactorTestValue = systemFactor;
        final AppSettingsController c = await _boot(<String, Object>{
          kTextScaleKey: 'large',
        });
        addTearDown(c.dispose);
        final TextScaler ours = await _effectiveScaler(tester, c);

        // 🔴 The control is what the user would get **without this card's
        // layer**: the system scaler MediaQuery takes directly from the
        // view. We cannot have `ours` compute itself (that is circular),
        // so a second tree without TextScaleScope is stood up to read it.
        late TextScaler baseline;
        await tester.pumpWidget(
          MaterialApp(
            home: _ScalerProbe(onBuild: (TextScaler s) => baseline = s),
          ),
        );

        for (final double size in <double>[10, 10.5, 11, 12, 13.5, 14, 15, 19]) {
          expect(
            ours.scale(size),
            baseline.scale(size),
            reason: 'system=$systemFactor size=$size: the large step is not today\'s behaviour',
          );
        }
      }
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    });
  });

  // ── ⑤ no overflow at three sites under all three steps (ruler: see header; Ahem is the conservative direction) ──
  group('⑤ no tier overflows (three steps until 0.3.28, five since)', () {
    testWidgets('PTT area: every tier × the longest hint, none overflow',
        (WidgetTester tester) async {
      // en's "Release to send · swipe up to cancel" is the longest sentence (recorded on card U12).
      // PA-2: the caption line under the bar joins the same harness — mirrored
      // from the composer's own rendering (same [pttCaption] selector, same
      // maxLines/ellipsis face), so "caption at ×2.0 scale" is measured where
      // it actually renders. A long PC name feeds the processing branch.
      const AppStrings en = AppStringsEn();
      for (final AppTextScale step in AppTextScale.values) {
        for (final PttVisual visual in PttVisual.values) {
          final AppSettingsController c = await _boot(<String, Object>{
            kTextScaleKey: step.name,
          });
          addTearDown(c.dispose);
          final String caption = pttCaption(
            visual: visual,
            nextPolicy: SendPolicy.direct,
            activePolicy: SendPolicy.direct,
            recordOnly: false,
            pcName: 'dev-pc-a',
            strings: en,
          );
          await tester.pumpWidget(
            MaterialApp(
              builder: (BuildContext context, Widget? page) =>
                  TextScaleScope(appSettings: c, child: page!),
              home: Scaffold(
                body: SizedBox(
                  // 🔴 0.3.28 — WAS a bare `360`, and that number was doing two
                  // jobs at once: "the product must work on a 360dp phone" AND
                  // "how much Ahem inflates this script". `support/legibility.
                  // dart`'s header names that exact fusion as the mistake, and
                  // this is the last measure point in the suite still making it.
                  //
                  // 🔴 THE RED THAT FOUND IT WAS A RULER RED, NOT A PRODUCT RED,
                  // and here are the numbers rather than the claim [measured on
                  // dev-pc-a via a throwaway probe, 2026-08-24]:
                  // the longest caption (`disabled`, 57 chars) needs, on ONE
                  // unconstrained Ahem line, 612.8px at `large` → 702.5 at
                  // `xlarge` → **792.3 at `xxlarge`**. A bare-360 box gives two
                  // lines ≈ 720px of capacity, so `xxlarge` misses by ~72px and
                  // `didExceedMaxLines` went true. Against the box a 360dp
                  // screen is actually worth for Latin under Ahem
                  // (`ahemWidthFor(360, en)` = 648 ⇒ ~1296px over two lines) the
                  // same 792.3 has ~40% headroom.
                  //
                  // ⚠️ Stated so nobody has to take it on faith that this is a
                  // ruler fix and not a test being loosened to go green: the
                  // case still has teeth in the direction that matters — push
                  // `xxlarge`'s factor to 3.0 and the need becomes ~1828px,
                  // which this budget refuses. That reverse control was run.
                  width: ahemWidthFor(360, AppLocale.en),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      PttBar(
                        visual: visual,
                        strings: en,
                        onDown: () async => true,
                        onUp: () async {},
                        onCancel: () async {},
                      ),
                      if (caption.isNotEmpty)
                        Text(
                          caption,
                          key: const ValueKey<String>('ptt.caption'),
                          textAlign: TextAlign.center,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 10.5),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          );
          expect(
            tester.takeException(),
            isNull,
            reason: 'PTT area overflowed at ${step.name} × ${visual.name}',
          );
          if (caption.isNotEmpty) {
            expect(
              tester
                  .renderObject<RenderParagraph>(
                    find.byKey(const ValueKey<String>('ptt.caption')),
                  )
                  .didExceedMaxLines,
              isFalse,
              reason:
                  'PA-2 caption was clipped at ${step.name} × ${visual.name} (two lines were not enough)',
            );
          }
        }
      }
    });

    testWidgets('header: three steps × long machine name + long focus title, none overflow, and the name is not robbed of width',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppTextScale step in AppTextScale.values) {
        final AppSettingsController c = await _boot(<String, Object>{
          kTextScaleKey: step.name,
        });
        addTearDown(c.dispose);
        final FakeSocketTransport transport = FakeSocketTransport();
        final ChatController controller = _chatController(transport);
        addTearDown(() async {
          await controller.dispose();
          controller.destination.dispose();
          controller.store.dispose();
        });
        controller.session.connectedDeviceName.value = 'dev-pc-a';
        controller.session.serverChannel.value = ServerChannel.lan;
        transport.pushStatus(SocketStatus.connected);
        controller.destination.onFocusApp(
          'M3窗口主控启动与关键任务收口 - CLAUDE.md - flowmic-app - Cursor',
        );

        await tester.pumpWidget(
          MaterialApp(
            builder: (BuildContext context, Widget? page) =>
                TextScaleScope(appSettings: c, child: page!),
            home: ChatFlowPage(controller: controller, onBack: () {}),
          ),
        );
        await tester.pump();
        expect(
          tester.takeException(),
          isNull,
          reason: 'header overflowed at the ${step.name} step',
        );

        // 0.2.51 law: when identity and a transient value share a row, the
        // compressible one must be the transient. Shrinking type size must
        // not rewrite that rule (the shrink direction is theoretically
        // safer, but "theoretically safe" is exactly the phrase this repo
        // has paid for).
        //
        // 🔴 **The criterion was swapped once on 2026-08-07 (W5a
        // adversarial review P2-1, [measured]).** The original was
        // `expect(tester.widget<Text>(nameFinder).data, 'dev-pc-a')`
        // — that is a **tautology**: `chat_header.dart` sets this `Text`
        // to `maxLines: 1` + `overflow: ellipsis`, so when it is squeezed
        // the screen shows `HANBJ-OF…` while `Text.data` **is still the
        // whole name**. It asserts the string we fed in, not the glyphs
        // the user reads — exactly the shape the 0.2.53 law names and
        // forbids, written inside an assertion that exists specifically
        // so "the name is not robbed of width".
        // ⇒ Switch to geometry: **painted width ≥ the width the full name
        // needs** (precedent: `chat_header_name_not_starved_widget_test.dart`,
        // the 0.2.51 card). `didExceedMaxLines` here is a **real reading**
        // (the product really set maxLines), so both are asserted
        // together: no ellipsis appeared, and not a pixel was squeezed
        // off.
        //
        // ⚠️ **"How wide does it need" must ask the already-laid-out
        // paragraph, never recompute from `Text.style`** (`neededWidthOf`,
        // not `intrinsicWidthOf`). The first version was written that
        // way, and **the medium step went red immediately**: painted
        // 190.0px, recomputed 202.5px — the difference is this card's
        // protagonist `MediaQuery.textScaler`, which `TextPainter` itself
        // does not know about. **What went red was the ruler, not the
        // product.** (Check your ruler first; using a ruler that cannot
        // see type-size scaling on a card that **measures type-size
        // scaling** is the cleanest example this law can give.)
        final Finder nameFinder =
            find.byKey(const ValueKey<String>('chat.deviceName'));
        expect(nameFinder, findsOneWidget, reason: 'the name vanished at the ${step.name} step');
        expect(
          tester.widget<Text>(nameFinder).data,
          'dev-pc-a',
          reason: 'the name that was fed in is already wrong (this case only answers "what was fed", not "what was seen")',
        );
        expectLegible(tester, nameFinder, reason: '${step.name} step');
        final double namePainted = tester.getSize(nameFinder).width;
        final double nameNeeds =
            neededWidthOf(tester.renderObject<RenderParagraph>(nameFinder));
        expect(
          namePainted,
          greaterThanOrEqualTo(nameNeeds - 0.5),
          reason: '${step.name} step: the name was squeezed to ${namePainted.toStringAsFixed(1)}px'
              ' (full name needs ${nameNeeds.toStringAsFixed(1)}px) ⇒ the screen shows HANBJ-OF…',
        );

        // 🔴 Positive control, without which the assertion above is idle:
        // this row must **really** not fit everything, otherwise "the name
        // is intact" only means this focus title is not long enough. The
        // destination badge is the transient that should be compressed
        // (`Flexible` in `destination_badge.dart`); if it was not
        // compressed, this run never created competition.
        final Finder badgeFinder = find.textContaining('M3窗口主控启动与关键任务');
        expect(badgeFinder, findsWidgets, reason: '${step.name} step: the focus title was not painted');
        final RenderParagraph badge =
            tester.renderObject<RenderParagraph>(badgeFinder.first);
        expect(
          badge.size.width,
          lessThan(neededWidthOf(badge) - 1),
          reason: '${step.name} step: the badge was not compressed ⇒ this row has no width pressure, this case is blind',
        );
      }
    });

    testWidgets('status badge: width is monotonic in the tier, and the TOP tier still fits a real screen\'s per-script budget',
        (WidgetTester tester) async {
      // 🔴 **Check your ruler first.** This case originally wrote "fits in
      // 240dp without overflow" — that 240 was a number I picked, and it
      // was already red at the **large step** (= today's behaviour, this
      // card did not move a pixel of it): `large / en / delivering`
      // overflowed 32px. So that ruler was measuring "how wide is the
      // Ahem placeholder font", not "did this card break anything".
      // ⇒ Switch to the **large step's own intrinsic width** as the
      // budget: today's layout already has to hold it.
      //   This card's product promise is "only shrink", so what must be
      //   asserted is **monotonicity** — medium/small must not be wider
      //   than large, and none of the three steps overflow in a box that
      //   「大」 fits.
      //   This assertion depends on no constant; it still holds if the
      //   font or the copy changes.
      //
      // 🔴🔴 **IN-PLACE CORRECTION (0.3.28, owner 2026-08-23). The paragraph
      // above is kept verbatim: every sentence in it was true when written,
      // and its ruler argument still is. What expired is its PREMISE.**
      //
      // FB-4's promise was "only shrink" (1.00 / 0.92 / 0.85, the default
      // already the ceiling). 0.3.28 appends `xlarge` 1.15 and `xxlarge` 1.30
      // because a user who found the text too small had, measurably, no
      // control at all. ⇒ `widths[step] <= widths[large]` is now **false by
      // design**, and its own failure text said what that means: "the 'only
      // shrink' premise is broken, every 'layout-direction-safe' claim on this
      // card has to be redone". This is that redo — the assertion is not
      // deleted, it is **replaced by the two claims that are true now**:
      //
      //   ① **monotonicity in the tier order** — a wider factor must not
      //      produce a narrower pill. This is the positive control: it is the
      //      only thing here that would go red if the scaler stopped reaching
      //      the pill at all (two equal-width runs prove nothing about which
      //      tier was in force);
      //   ② **the top tier fits the box a real screen actually gives it** —
      //      `ahemWidthAtLeast(600, 411, locale)`, the same per-script ruler
      //      the rest of this suite uses, NOT the top tier's own intrinsic
      //      width. Sizing the box to what the widest tier happens to need
      //      would be circular: it would pass for any factor whatsoever,
      //      including one that makes the pill wider than any phone.
      //
      // ⚠️ Ruler asymmetry unchanged (file header): Ahem inflates, so "fits
      // here ⇒ fits on a real device" holds and the converse does not. That is
      // the direction this case needs — it is asking "can the top tier clip".
      for (final AppLocale locale in AppLocale.values) {
        for (final DeliveryFace face in DeliveryFace.values) {
          final Map<AppTextScale, double> widths = <AppTextScale, double>{};
          for (final AppTextScale step in AppTextScale.values) {
            final AppSettingsController c = await _boot(<String, Object>{
              kTextScaleKey: step.name,
            });
            addTearDown(c.dispose);
            // Unconstrained width ⇒ take the pill's intrinsic width (StatusPill is mainAxisSize.min).
            await tester.pumpWidget(
              MaterialApp(
                builder: (BuildContext context, Widget? page) =>
                    TextScaleScope(appSettings: c, child: page!),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.topLeft,
                    child: SizedBox(
                      width: 4000,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          StatusPill(face, strings: AppStrings.of(locale)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            );
            widths[step] = tester.getSize(find.byType(StatusPill)).width;
          }

          // ② The box a real 411dp screen is worth for THIS script. A constant
          // here would be the 240dp mistake again; the top tier's own
          // intrinsic width would be circular. This is the one number that is
          // neither.
          final double budget = ahemWidthAtLeast(600, 411, locale);
          // Positive control: this pill must actually have width, otherwise the comparison below is two zeros.
          expect(widths[AppTextScale.large]!, greaterThan(0),
              reason: '${locale.name}/${face.name} pill width is 0 ⇒ this round measured nothing');

          // ① Monotonic in the tier order. Sorted by factor rather than by
          // declaration order on purpose: the enum's order is a storage
          // contract (`AppTextScale.name` is the pref value), so a future
          // append must not be able to silently reorder what this asserts.
          final List<AppTextScale> byFactor = AppTextScale.values.toList()
            ..sort((AppTextScale a, AppTextScale b) => a.factor.compareTo(b.factor));
          for (int i = 1; i < byFactor.length; i++) {
            expect(
              widths[byFactor[i]]!,
              greaterThanOrEqualTo(widths[byFactor[i - 1]]! - 0.01),
              reason: '${byFactor[i].name} (×${byFactor[i].factor}) is NARROWER than '
                  '${byFactor[i - 1].name} (×${byFactor[i - 1].factor}) on '
                  '${locale.name}/${face.name} — either the tier is not reaching '
                  'this pill at all, or two tiers are wired to the same factor',
            );
          }
          expect(
            widths[AppTextScale.xxlarge]!,
            lessThanOrEqualTo(budget),
            reason: 'the top tier needs ${widths[AppTextScale.xxlarge]!.toStringAsFixed(1)}px on '
                '${locale.name}/${face.name}, more than the ${budget.toStringAsFixed(1)}px a '
                '411dp screen is worth for this script ⇒ shipping xxlarge clips this pill',
          );

          // Walk again: in that box, no tier may overflow even once.
          for (final AppTextScale step in AppTextScale.values) {
            final AppSettingsController c = await _boot(<String, Object>{
              kTextScaleKey: step.name,
            });
            addTearDown(c.dispose);
            await tester.pumpWidget(
              MaterialApp(
                builder: (BuildContext context, Widget? page) =>
                    TextScaleScope(appSettings: c, child: page!),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.topLeft,
                    child: SizedBox(
                      width: budget,
                      child: StatusPill(face, strings: AppStrings.of(locale)),
                    ),
                  ),
                ),
              ),
            );
            expect(
              tester.takeException(),
              isNull,
              reason: 'status badge overflowed: ${step.name} / ${locale.name} / ${face.name}',
            );
          }
        }
      }
    });
  });

  // ── ⑥ all languages ────────────────────────────────────────────────────
  group('⑥ all languages present and pairwise distinct', () {
    test('every copy string on the type-size row is non-empty in every language; the five read-outs are distinct and in size order', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        // A locale that has not been translated falls back to English
        // structurally (gen-mobile-dart's `extends AppStringsEn`), so
        // "non-empty" cannot be satisfied by a bare key.
        for (final String v in <String>[
          s.textScaleTitle,
          s.textScaleNote(_pct(AppTextScale.large)),
        ]) {
          expect(v, isNotEmpty, reason: locale.name);
        }
        // The note must really carry the number — a translation that dropped
        // the `$pct` hole would read 「 matches how the app looked before」 and
        // nothing else in the suite would notice.
        expect(
          s.textScaleNote(_pct(AppTextScale.large)),
          contains(_pct(AppTextScale.large)),
          reason: '${locale.name}: the note lost the percentage it was handed',
        );
      }

      // 🔴 REPLACES 「the step names are pairwise distinct within a language」
      // (retired 2026-08-27; the full reasoning is in this file's header). The
      // old assertion was GREEN on the very defect it existed to catch: Large
      // / Larger / Largest are three distinct strings that owner read as one
      // word repeated. Distinctness of *names* was never the property; being
      // *tellable apart, in order* is — and that is what a number is for.
      //
      // Language-free on purpose: there is exactly one set of read-outs now,
      // shared by all nine locales, which is itself half the fix.
      final List<String> readOuts =
          AppTextScale.ladder.map(_pct).toList();
      expect(readOuts.toSet(), hasLength(AppTextScale.values.length),
          reason: 'two rungs read the same on screen: $readOuts');
      for (int i = 1; i < AppTextScale.ladder.length; i++) {
        expect(
          AppTextScale.ladder[i].percent,
          greaterThan(AppTextScale.ladder[i - 1].percent),
          reason: 'the read-outs do not increase with the rung: $readOuts',
        );
      }
      // The baseline the ruling named, pinned: medium is 100%.
      expect(AppTextScale.medium.percent, 100);
    });

    test('🔴 the five adjective names are gone from all nine catalogue files, not merely unread', () {
      // 🔴 「No adjective tier name is visible anywhere」 is the ruling's
      // requirement, and a test that only stopped CALLING those getters would
      // stay green while the strings still shipped in nine files, waiting for
      // the next person to hang a second meaning on them (the anti-façade
      // rule works in this direction too: a string with no consumer is not
      // evidence of anything except that nobody has found it yet).
      //
      // Reads the catalogue rather than the generated Dart on purpose: the
      // JSON is the source, and `leaves.json` is what would resurrect a key.
      const List<String> retired = <String>[
        'textScaleSmall',
        'textScaleMedium',
        'textScaleLarge',
        'textScaleXlarge',
        'textScaleXxlarge',
      ];
      // 🔴 The directory is ENUMERATED, not listed. The first version of this
      // case wrote out `['en', 'zh-CN', 'zh-TW', …]` and `verify:lint`'s
      // `i18n-add-locale-cost` caught it on the spot ("1 file(s) gained a
      // hand-rolled locale list — adding a language must not mean editing
      // these"). The gate is right and the enumerated form is also the
      // stronger test: a tenth language arrives already covered.
      final Directory dir = Directory('../../i18n/mobile');
      expect(dir.existsSync(), isTrue,
          reason: '${dir.path} is not where this case looked — from apps/mobile');
      final List<File> catalogues = dir
          .listSync()
          .whereType<File>()
          .where((File f) => f.path.endsWith('.json'))
          // `coverage.json` is a generated report, not a catalogue; this is
          // what tells the two apart without naming either.
          .where((File f) => f.readAsStringSync().contains('textScaleNote'))
          .toList();
      // Positive control: without it, a wrong path or a changed key name makes
      // every assertion below vacuous — zero files, zero failures, green.
      expect(
        catalogues.length,
        greaterThanOrEqualTo(AppLocale.values.length + 1),
        reason: 'found only ${catalogues.length} catalogue file(s); expected one per UI '
            'language (${AppLocale.values.length}) plus leaves.json ⇒ this case read almost nothing',
      );
      for (final File f in catalogues) {
        final String src = f.readAsStringSync();
        for (final String key in retired) {
          expect(src, isNot(contains('"$key"')),
              reason: '${f.path} still ships "$key" — the adjective the slider was ruled in to remove');
        }
      }
    });

    testWidgets('🔴 the "multiplied on top of the system" note is readable on the narrowest screen (assert the rendered result, not Text.data)',
        (WidgetTester tester) async {
      // 0.2.53 law: any acceptance of "can the user read this sentence" must land the assertion on the rendered result.
      // ⚠️ Under Ahem this sentence is much wider than on a real device — this direction is conservative (see header).
      //
      // 🔴 The ruler was swapped once on 2026-08-07 (W5a adversarial review
      // P1-1, [measured]): the original was
      // `expect(p.didExceedMaxLines, isFalse)`, and the `Text` below does
      // not set `maxLines` ⇒ that reading is constantly false, this case
      // is structurally incapable of going red. It now goes through
      // `support/legibility.dart`; the criterion is decided by the
      // structure of the text under test.
      tester.view.physicalSize = const Size(360 * 3, 900 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 332, // 360dp minus 14dp padding on each side of the settings card
                child: Text(
                  s.textScaleNote(_pct(AppTextScale.large)),
                  style: const TextStyle(fontSize: 11, height: 1.4),
                ),
              ),
            ),
          ),
        );
        expectLegible(
          tester,
          find.text(s.textScaleNote(_pct(AppTextScale.large))),
          reason: locale.name,
        );
      }
    });
  });

  // ── ⑦ 🔴 production really hung this layer ───────────────────────────────
  group('⑦ structural guard: main.dart is actually using it', () {
    test('MaterialApp\'s builder hangs TextScaleScope', () async {
      // Why read source instead of pump: a real `main()` needs sqflite,
      // secure storage, platform channels — it cannot be pumped in a test.
      // Same-technique precedent:
      // `first_run_locale_test.dart`'s "the first-run path contains no
      // platform-locale probe".
      // ⚠️ It proves "this line of code is there", not "it takes effect on
      // a real device". Real-device unproven, written plainly in the report.
      final String src = await File('lib/main.dart').readAsString();
      expect(src, contains('TextScaleScope('),
          reason: 'production did not hang this layer ⇒ the whole card is a façade');
      expect(src, contains('import \'src/ui/text_scale_scope.dart\';'));
      // It must live in `builder:` rather than wrapping MaterialApp —
      // the latter would give every route the Navigator pushes an
      // un-multiplied MediaQuery (= the step only takes effect on the
      // home page).
      final int builderAt = src.indexOf('builder: (BuildContext context, Widget? page)');
      final int scopeAt = src.indexOf('TextScaleScope(');
      expect(builderAt, greaterThan(-1), reason: 'MaterialApp no longer has a builder slot');
      expect(
        scopeAt,
        greaterThan(builderAt),
        reason: 'TextScaleScope is not inside MaterialApp.builder ⇒ pushed pages do not switch step',
      );
    });
  });
}
