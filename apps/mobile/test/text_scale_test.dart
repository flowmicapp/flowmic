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

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart' show SendPolicy;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flowmic/src/ui/text_scale_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/legibility.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

const String kTextScaleKey = 'flowmic.pref.textScale';

Future<AppSettingsController> _boot(Map<String, Object> initial) async {
  SharedPreferences.setMockInitialValues(initial);
  final AppSettingsController c = AppSettingsController(
    prefs: await SharedPreferences.getInstance(),
  );
  await c.load();
  return c;
}

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

/// A REAL [SettingsPage] under a REAL [TextScaleScope], with the nine
/// controllers the page demands, all faked. Same shape as `main.dart`: the scope
/// lives in `MaterialApp.builder`, so everything the page pushes is under it.
///
/// 🔴 WHY THIS EXISTS. Before this window's fix lane, the three production chips
/// `settings.textScale.{large,medium,small}` had ZERO references anywhere under
/// `test/`. The "wiring" test in group ② below calls `c.setTextScale(...)`
/// directly with a comment saying that is "what that row on the settings page
/// does" — an assertion about behaviour elsewhere with nothing pinning it
/// (anti-façade ④).
/// Measured consequence: **delete the whole type-size row from
/// `settings_preferences.dart` and the entire suite stays green**, exactly the
/// shape 13 册 §7 F1 ① names (a lost call site leaves no new symbol to grep).
/// `page_guides_test.dart` in this same window taps two real production keys on
/// a real page; this rig makes that possible here.
class _SettingsRig {
  late final FakeSocketTransport settingsTransport;
  late final SettingsClient settingsClient;
  late final ScenarioCardController scenario;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;
  late final AppSettingsController appSettings;

  /// [c] is owned by the caller (it is the controller under test).
  static Future<_SettingsRig> create(AppSettingsController c) async {
    final _SettingsRig r = _SettingsRig();
    r.appSettings = c;
    r.settingsTransport = FakeSocketTransport();
    r.settingsClient = SettingsClient(
        transport: r.settingsTransport, roomJoins: ValueNotifier<int>(0));
    r.scenario = ScenarioCardController(
      settingsClient: r.settingsClient,
      cache: InMemoryScenarioCardCache(),
    );
    await r.scenario.load();
    r.session = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.login = newTestLogin(transport: r.session.transport);
    r.destination = DestinationController();
    return r;
  }

  Widget widget() => MaterialApp(
    builder: (BuildContext context, Widget? page) =>
        TextScaleScope(appSettings: appSettings, child: page!),
    home: SettingsPage(
      scenario: scenario,
      appSettings: appSettings,
      login: login,
      destination: destination,
      session: session,
      portable: newTestPortableController(),
      inventory: newTestInventory(
        rows: const <TimelineEntry>[],
        images: newTestOutboxBlobs(),
      ),
      timeline: newTestStore(),
      version: const FixedAppVersion('0.0.0-test'),
      update: newTestUpdateController(),
    ),
  );

  Future<void> dispose() async {
    await settingsClient.dispose();
    login.dispose();
    scenario.dispose();
    destination.dispose();
    await session.dispose();
    await settingsTransport.close();
  }
}

/// A viewport tall enough that the whole settings `ListView` is laid out, so the
/// preferences card is really built. Same trick and same reason as
/// `about_version_widget_test.dart`'s `tallViewport`.
void _tallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 4200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
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
      // The three numbers owner ruled, pinned verbatim: changing a factor must be a conscious act.
      expect(AppTextScale.large.factor, 1.00);
      expect(AppTextScale.medium.factor, 0.92);
      expect(AppTextScale.small.factor, 0.85);
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

  // ── ②b 🔴 wiring: the three chips really exist on the real settings page, tapping them really switches the step ──
  group('②b wiring (real page · real keys · real render tree)', () {
    testWidgets('all three chips are on a real SettingsPage; tapping each one switches the whole page to that step',
        (WidgetTester tester) async {
      // 🔴 This case's criterion is **those three production keys**:
      // `settings.textScale.{large,medium,small}` from
      // `settings_preferences.dart`, tapped by `tester.tap` on a real
      // `SettingsPage`, reading from `MediaQuery.textScalerOf` **at the
      // chip's own location** — the one every `Text` in the same tree
      // actually asks at layout. Three facts asserted at once: the row is
      // there (otherwise findsOneWidget goes red), it is tappable, and the
      // tap reaches the render tree.
      //
      // 🔴 **Why walk every step instead of tapping one chip**: hanging
      // all three chips on the same step (the most common copy-paste slip)
      // stays fully green under a "tap one chip" test.
      //
      // 🔴 Reverse control [measured 2026-08-07]: lift the three
      // `(AppTextScale.*, s.textScale*)` tuples out of that list in
      // `settings_preferences.dart` (no chip drawn, title and note
      // unchanged), this case went red immediately, verbatim:
      //   Expected: exactly one matching candidate
      //     Actual: _KeyWidgetFinder:<Found 0 widgets with key
      //             [<'settings.textScale.large'>]: []>
      //      Which: means none were found but one was expected
      //   设置页上没有 `settings.textScale.large` 这枚 chip —— FB-4 的那一行
      //   不在产品里了
      // ⚠️ The same measured run also confirmed why this card must exist:
      // **every other case in this file stayed green** (②③④⑤⑥⑦ not one
      // red) — before the three chips were lifted, the reference count of
      // `settings.textScale.*` under all of `test/` was **0**.
      // Restored, re-greened, `REVERSE-CONTROL-LANEB` leftover-string
      // grep = 0.
      _tallViewport(tester);
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      final _SettingsRig rig = await _SettingsRig.create(c);
      addTearDown(rig.dispose);

      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();

      Finder chip(AppTextScale step) =>
          find.byKey(ValueKey<String>('settings.textScale.${step.name}'));

      // Named up front so「the row was deleted」reports itself as that, instead
      // of as a bare `Bad state: No element` out of `tap` (page_guides_test.dart
      // wrote that lesson down after its own reverse control).
      for (final AppTextScale step in AppTextScale.values) {
        expect(
          chip(step),
          findsOneWidget,
          reason: 'the settings page has no `settings.textScale.${step.name}` chip — '
              'FB-4\'s row is no longer in the product',
        );
      }
      // The row's title and note must also be there (a chip row with no title cannot answer "what is this").
      final AppStrings s = AppStrings.of(c.locale);
      expect(find.text(s.textScaleTitle), findsOneWidget);
      expect(find.text(s.textScaleNote), findsOneWidget);

      // Reading is taken at the chip's own location — it sits under TextScaleScope.
      double scalerAtChip(AppTextScale step) =>
          MediaQuery.textScalerOf(tester.element(chip(step))).scale(10);

      expect(scalerAtChip(AppTextScale.large), closeTo(10.0, 1e-9),
          reason: 'the default is no longer 「大」');

      for (final AppTextScale step in <AppTextScale>[
        AppTextScale.medium,
        AppTextScale.small,
        AppTextScale.large,
      ]) {
        await tester.tap(chip(step));
        await tester.pumpAndSettle();
        expect(c.textScale, step, reason: 'tapping ${step.name} did not land on the controller');
        expect(
          scalerAtChip(step),
          closeTo(10 * step.factor, 1e-9),
          reason: 'after tapping ${step.name} the whole page did not switch to this step — '
              'this chip either is not wired to setTextScale, or is wired to a different step',
        );
      }
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
  group('⑤ none of the three steps overflow', () {
    testWidgets('PTT area: three steps × the longest hint, none overflow',
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
                  width: 360,
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

    testWidgets('status badge: medium/small must not be tighter than 「大」 (large = today\'s behaviour, that is the ruler)',
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

          final double budget = widths[AppTextScale.large]!;
          // Positive control: this pill must actually have width, otherwise the comparison below is two zeros.
          expect(budget, greaterThan(0),
              reason: '${locale.name}/${face.name} pill width is 0 ⇒ this round measured nothing');
          for (final AppTextScale step in AppTextScale.values) {
            expect(
              widths[step]!,
              lessThanOrEqualTo(budget + 0.01),
              reason: '${step.name} is wider than the large step: ${locale.name}/${face.name} '
                  '(${widths[step]} > $budget) — the "only shrink" premise is broken, '
                  'every "layout-direction-safe" claim on this card has to be redone',
            );
          }

          // Walk again: in the box that the large step fits, none of the three steps may overflow even once.
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

  // ── ⑥ four languages ────────────────────────────────────────────────────
  group('⑥ all four languages present and pairwise distinct', () {
    test('the five copy strings on the type-size row are non-empty in all four languages; the three step names are pairwise distinct within a language', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String v in <String>[
          s.textScaleTitle,
          s.textScaleLarge,
          s.textScaleMedium,
          s.textScaleSmall,
          s.textScaleNote,
        ]) {
          expect(v, isNotEmpty, reason: locale.name);
        }
        // Three step names colliding = the user sees three identical chips.
        expect(
          <String>{s.textScaleLarge, s.textScaleMedium, s.textScaleSmall},
          hasLength(3),
          reason: locale.name,
        );
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
                  s.textScaleNote,
                  style: const TextStyle(fontSize: 11, height: 1.4),
                ),
              ),
            ),
          ),
        );
        expectLegible(tester, find.text(s.textScaleNote), reason: locale.name);
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
