// Spoken-language (source_lang) acceptance — assert the name and the effective
// value separately.
//
// 🔴 Why this file exists (the law window D1 established, CLAUDE.md
// required-reading §2): **A test that only asserts the label stays green when
// the label moved and the gate did not.** A test that only proves "the chip
// was persisted" still goes fully green when `ChatController.pttDown` never
// passes this value to `PttSession.pttDown` at all, and every utterance still
// goes on the wire hardcoded as 'zh' — that was the real state before this
// round's change (`apps/mobile/lib/src/ptt/ptt_session.dart` `pttDown`'s
// parameter default `sourceLang = 'zh'` was the App's only actual value,
// because the sole production call site never passed it).
//
// ⚠️ Deliberately no line numbers (original `:637`, changed 2026-08-07 W5a):
// that line was pushed to 704 this round; this citation and the one in
// `app_settings.dart` both went stale at once and blocked the whole-repo
// pre-commit. **A file that is being changed must not be cited by line
// number** — a symbol anchor stays valid no matter how it moves.
//
// So every group here is a pair:
//   ① the name — the setting was persisted and is still there after reopen;
//   ② the effective value — `source_lang` on the `audio:start` frame really
//      became the selected tag.
// Reverse control (measured red): delete the `sourceLang: _activeSourceLang`
// line in `chat_controller.dart` and ① stays fully green, ② goes fully red.
//
// 🔴 Tag-vocabulary criterion (group 5 asserts this directly): routing is
// **exact string equality** (`apps/server-core/src/stt/engine-router.ts`
// `selectRoutingWithSource`), and the table the server seeds onto every
// account uses **bare ISO 639-1 codes**
// (`apps/server-core/src/settings/defaults.ts` `buildDefaultSettings`'s
// `'zh'` and `'*'`). The presets' `language_hint: 'zh-CN'` does not
// participate in routing (zero runtime consumers). Sending `zh-CN` silently
// misses the exact route prepared for Chinese — **it still looks like it
// works**, so this one must be watched by a machine.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

/// Real data layer + real AppSettingsController (mock prefs); only socket /
/// recorder are stand-ins.
class _Harness {
  late final SharedPreferences prefs;
  late final AppSettingsController appSettings;
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  static Future<_Harness> create({Map<String, Object> seed = const <String, Object>{}}) async {
    final _Harness h = _Harness();
    SharedPreferences.setMockInitialValues(seed);
    h.prefs = await SharedPreferences.getInstance();
    h.appSettings = AppSettingsController(prefs: h.prefs);
    await h.appSettings.load();
    h.transport = FakeSocketTransport();
    h.session = newTestSession(
      transport: h.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      // Collapse the JUST_DONE dwell so one test can speak two utterances
      // (to verify "it takes effect on the next utterance") without actually
      // sleeping through it. Only the duration changes; the state transition
      // itself is untouched.
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(h.session);
    h.store = newTestStore();
    h.destination = DestinationController();
    h.gate = TimelineSyncGate(transport: h.transport);
    h.controller = ChatController(
      session: h.session,
      store: h.store,
      destination: h.destination,
      syncGate: h.gate,
      localPrefs: InMemoryLocalPrefs(),
      appSettings: h.appSettings,
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    );
    h.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    return h;
  }

  /// Finish this utterance: PROCESSING waits forever for `stt:final`; without
  /// feeding it the FSM never returns to IDLE, and the next `pttDown` is
  /// rejected outright by `canPtt` (the first version already hit this).
  Future<void> finishUtterance({String text = '喂'}) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
  }

  /// Run one full press-and-release; return `source_lang` from this
  /// utterance's `audio:start` frame.
  ///
  /// ⚠️ Reads the **frame**, not a field on the controller — the controller
  /// can remember a value it never sent (that was the shape before this
  /// round).
  Future<String?> speakAndReadWireSourceLang() async {
    final int before = transport.emittedWhere(FlowMicEvents.audioStart).length;
    await controller.pttDown();
    await controller.pttUp();
    await finishUtterance();
    final List<EventEnvelope> starts =
        transport.emittedWhere(FlowMicEvents.audioStart);
    expect(
      starts.length,
      before + 1,
      reason: 'this utterance must have actually emitted one audio:start '
          'frame — positive control, otherwise the "equals X" below may just '
          'mean the probe is blind',
    );
    final Map<String, Object?> payload =
        Map<String, Object?>.from(starts.last.data! as Map);
    return payload['source_lang'] as String?;
  }

  Future<void> dispose() async {
    await controller.dispose();
    appSettings.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

const String _kSpokenLangPrefKey = 'flowmic.pref.spoken_lang';

void main() {
  group('① name: spoken language persists on change (this group stays fully green under reverse control — so it is not enough)', () {
    test('chose Japanese → persisted to its own key, and still there after reopen', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);

      expect(h.appSettings.spokenLang, kSpokenLangDefault,
          reason: 'never chosen = documented default zh');

      h.appSettings.setSpokenLang('ja');
      expect(h.appSettings.spokenLang, 'ja');
      expect(h.prefs.getString(_kSpokenLangPrefKey), 'ja',
          reason: 'persist on change: written in the same tap, no save button');

      // Reopen: new controller on the same prefs, equivalent to hydrate on
      // next launch.
      final AppSettingsController reopened =
          AppSettingsController(prefs: h.prefs);
      await reopened.load();
      expect(reopened.spokenLang, 'ja');
      reopened.dispose();
    });

    test('🔴 UI language and spoken language are two keys, two value spaces: changing one must never move the other', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);

      h.appSettings.setLocale(AppLocale.zh);
      expect(h.appSettings.spokenLang, kSpokenLangDefault,
          reason: 'changing the UI to Chinese must not casually change speech recognition to Chinese too');

      h.appSettings.setSpokenLang('ja');
      expect(h.appSettings.locale, AppLocale.zh,
          reason: 'the reverse is the same — speaking Japanese does not mean the UI must become Japanese');
      expect(h.prefs.getString('flowmic.pref.locale'), 'zh');
      expect(h.prefs.getString(_kSpokenLangPrefKey), 'ja');
    });

    test('tags outside the vocabulary are never persisted (routing is exact match; writing one in is giving a fake choice)',
        () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);

      h.appSettings.setSpokenLang('ja-JP');
      expect(h.appSettings.spokenLang, kSpokenLangDefault);
      expect(h.prefs.getString(_kSpokenLangPrefKey), isNull);
    });

    test('a stored tag we do not recognise → hydrate falls back to default, does not throw', () async {
      final _Harness h = await _Harness.create(
        seed: <String, Object>{_kSpokenLangPrefKey: 'klingon'},
      );
      addTearDown(h.dispose);
      expect(h.appSettings.spokenLang, kSpokenLangDefault);
    });
  });

  group('② effective value: audio:start.source_lang on the wire really changed (this group goes red under reverse control)', () {
    test('🔴 after choosing Japanese, the next utterance\'s source_lang on the wire is ja', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);

      h.appSettings.setSpokenLang('ja');
      expect(await h.speakAndReadWireSourceLang(), 'ja');
    });

    test('unconfigured old-install behaviour is byte-identical: still zh on the wire', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);
      expect(await h.speakAndReadWireSourceLang(), kSpokenLangDefault);
    });

    test('🔴 the positive half of the reverse control: after choosing ja it cannot still be zh on the wire', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);

      h.appSettings.setSpokenLang('ja');
      expect(await h.speakAndReadWireSourceLang(), isNot(kSpokenLangDefault),
          reason: 'this one is for "the setting was stored but never wired": that implementation is always zh here');
    });

    test('§4.0 B rhythm: changing the setting mid-utterance cannot change the utterance already being spoken', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.dispose);

      await h.controller.pttDown();
      h.appSettings.setSpokenLang('ko'); // mid-utterance change
      await h.controller.pttUp();
      await h.finishUtterance();

      final Map<String, Object?> first = Map<String, Object?>.from(
        h.transport.emittedWhere(FlowMicEvents.audioStart).single.data! as Map,
      );
      expect(first['source_lang'], kSpokenLangDefault,
          reason: 'this utterance was already locked at PTT-down (taken in place = snapshot)');

      // Takes effect on the next utterance.
      expect(await h.speakAndReadWireSourceLang(), 'ko');
    });
  });

  group('③ tag vocabulary: what goes out must be the string the routing table recognises', () {
    for (final String tag in kSpokenLangs) {
      test('$tag goes on the wire as-is (bare ISO 639-1 code, no region subtag)', () async {
        final _Harness h = await _Harness.create();
        addTearDown(h.dispose);

        h.appSettings.setSpokenLang(tag);
        final String? onWire = await h.speakAndReadWireSourceLang();
        expect(onWire, tag);
        expect(onWire, isNot(contains('-')),
            reason: '🔴 a regional form like zh-CN misses the exact '
                "'zh' route seeded by defaults.ts and silently falls to the wildcard '*' — vendor-side hints still change, "
                'so the eye cannot tell');
      });
    }

    test('the eight tags the picker offers are the shape of the routing-table keys (shape assertion on the gate itself)', () {
      // WP3 C11 (owner 2026-08-17): grown 4 → 8, registry picker order.
      expect(kSpokenLangs, <String>['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru']);
      expect(kSpokenLangDefault, 'zh');
      expect(kSpokenLangs, contains(kSpokenLangDefault));
    });

    test('🔴 zh-TW is deliberately NOT a spoken value (decision at kSpokenLangs: '
        'no engine on the path emits Traditional — measured, Soniox 400s the hint), '
        'and a stored zh-TW degrades to the default instead of shipping', () async {
      expect(kSpokenLangs, isNot(contains('zh-TW')));
      final _Harness h = await _Harness.create(
        seed: <String, Object>{_kSpokenLangPrefKey: 'zh-TW'},
      );
      addTearDown(h.dispose);
      expect(h.appSettings.spokenLang, kSpokenLangDefault,
          reason: 'a value the picker no longer (or never) offered must fall '
              'back, never throw and never ship a label the routing table has '
              'no row for');
    });

    test('every offered tag resolves to a REAL endonym label from AppLocale '
        '(the no-second-table invariant), and an unknown tag passes through as data', () {
      final AppStrings s = AppStrings.of(AppLocale.en);
      for (final String tag in kSpokenLangs) {
        final AppLocale l =
            AppLocale.values.firstWhere((AppLocale l) => l.name == tag);
        expect(s.spokenLangLabel(tag), '${l.endonym} ($tag)',
            reason: 'a spoken tag with no AppLocale row would silently render '
                'as a bare code — if this fires, the tag was added to '
                'kSpokenLangs without a registry row to name it');
      }
      expect(s.spokenLangLabel('xx'), 'xx',
          reason: 'unknown tags are data, not copy — never invent a name');
    });
  });

  group('④ the settings-page row: tapping a chip → really writes spoken language (not UI language)', () {
    testWidgets('tap the 「日本語」 chip → spokenLang=ja and locale does not move a pixel', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController appSettings =
          AppSettingsController(prefs: prefs);
      await appSettings.load();
      final FakeSocketTransport t = FakeSocketTransport();
      final SettingsClient settingsClient =
          SettingsClient(transport: t, roomJoins: ValueNotifier<int>(0));
      final ScenarioCardController scenario = ScenarioCardController(
        settingsClient: settingsClient,
        cache: InMemoryScenarioCardCache(),
      );
      await scenario.load();
      final PttSession session = newTestSession(
        transport: FakeSocketTransport(),
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      final LoginController login = newTestLogin(transport: session.transport);
      final DestinationController destination = DestinationController();
      addTearDown(() async {
        await settingsClient.dispose();
        login.dispose();
        scenario.dispose();
        appSettings.dispose();
        destination.dispose();
        await session.dispose();
        await t.close();
      });

      await tester.pumpWidget(
        MaterialApp(
          home: SettingsPage(
            scenario: scenario,
            appSettings: appSettings,
            login: login,
            destination: destination,
            session: session,
            portable: newTestPortableController(),
            inventory: newTestInventory(
              rows: const <TimelineEntry>[],
              images: InMemoryOutboxBlobStore(),
            ),
            timeline: newTestStore(),
            version: const FixedAppVersion('0.0.0-test'),
            update: newTestUpdateController(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(appSettings.locale);

      // 🔴 The two rows' chip copy is the same set of endonyms, so we must
      // locate by row — "casually find.text('日本語') and tap the first" would
      // hit the UI-language row.
      await tester.scrollUntilVisible(find.text(s.spokenLangTitle), 200);
      await tester.pumpAndSettle();
      expect(find.text(s.spokenLangNote), findsOneWidget,
          reason: '🔴 owner ruling: must say clearly that this governs the cloud-relay path, '
              'otherwise LAN users will think this can swap the engine on their own machine');

      final Finder spokenRow = find
          .ancestor(of: find.text(s.spokenLangTitle), matching: find.byType(Column))
          .first;
      await tester.tap(
        find.descendant(of: spokenRow, matching: find.text(s.spokenLangLabel('ja'))),
      );
      await tester.pumpAndSettle();

      expect(appSettings.spokenLang, 'ja');
      expect(prefs.getString(_kSpokenLangPrefKey), 'ja');
      expect(appSettings.locale, AppLocale.en,
          reason: 'tapped the spoken-language row; UI language must not follow');
      expect(prefs.getString('flowmic.pref.locale'), isNull);
    });

    testWidgets('0.2.53 law — all eight spoken chips RENDER un-clipped on a '
        '360dp phone (endonyms are locale-invariant, so one locale suffices)', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(360 * 3, 800 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      // ⚠️ MEASURED before asserting (WP3 C11 follow-up, 2026-08-18): at
      // 360dp under Ahem this page used to trip THREE RenderFlex overflows,
      // none of them the chips' (the same set fires on the pre-C11 tree; the
      // third was missed by the WP3 registration, which recorded two):
      //   · 99px / 50px — the data card's export and import rows: each kept a
      //     sentence-long CTA ("Choose a location and export") as an
      //     inflexible Row child, squeezing the title+sub column to ~30-70px
      //     in fr/ru/es/de real fonts at 360dp and overflowing a 320dp screen
      //     outright in fr — a REAL-device defect, not an Ahem artifact, so
      //     both rows moved to the _cloudInstanceRow vertical-stack shape;
      //   · 12px — the custom-terms footer: ghost button and hint as two
      //     rigid ends. Real fonts fit at scale 1.0 (worst ru ≈242px of the
      //     262px a 320dp screen offers) but FlowMicTextScaler multiplies the
      //     SYSTEM accessibility scale in, so one notch of large text eats
      //     that margin — the hint became an Expanded that wraps.
      // The collector below is therefore a RULER now, not a filter: the whole
      // page, scrolled to the bottom, must lay out with zero overflows.
      // Reverse control (measured red 2026-08-18): this assertion on the
      // pre-fix tree reports exactly the three overflows above.
      final List<String> pageOverflows = <String>[];
      final void Function(FlutterErrorDetails)? prevOnError =
          FlutterError.onError;
      FlutterError.onError = (FlutterErrorDetails d) {
        if (d.exceptionAsString().contains('overflowed')) {
          pageOverflows.add(d.exceptionAsString());
          return;
        }
        prevOnError?.call(d);
      };
      addTearDown(() => FlutterError.onError = prevOnError);

      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController appSettings =
          AppSettingsController(prefs: prefs);
      await appSettings.load();
      final FakeSocketTransport t = FakeSocketTransport();
      final SettingsClient settingsClient =
          SettingsClient(transport: t, roomJoins: ValueNotifier<int>(0));
      final ScenarioCardController scenario = ScenarioCardController(
        settingsClient: settingsClient,
        cache: InMemoryScenarioCardCache(),
      );
      await scenario.load();
      final PttSession session = newTestSession(
        transport: FakeSocketTransport(),
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      final LoginController login = newTestLogin(transport: session.transport);
      final DestinationController destination = DestinationController();
      addTearDown(() async {
        await settingsClient.dispose();
        login.dispose();
        scenario.dispose();
        appSettings.dispose();
        destination.dispose();
        await session.dispose();
        await t.close();
      });

      await tester.pumpWidget(
        MaterialApp(
          home: SettingsPage(
            scenario: scenario,
            appSettings: appSettings,
            login: login,
            destination: destination,
            session: session,
            portable: newTestPortableController(),
            inventory: newTestInventory(
              rows: const <TimelineEntry>[],
              images: InMemoryOutboxBlobStore(),
            ),
            timeline: newTestStore(),
            version: const FixedAppVersion('0.0.0-test'),
            update: newTestUpdateController(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(appSettings.locale);
      for (final String tag in kSpokenLangs) {
        final Finder chip = find.text(s.spokenLangLabel(tag));
        await tester.scrollUntilVisible(chip, 120);
        await tester.pumpAndSettle();
        expect(chip, findsOneWidget, reason: 'chip for $tag did not render');
        expect(
          tester.renderObject<RenderParagraph>(chip).didExceedMaxLines,
          isFalse,
          reason: 'chip label for $tag was eaten by an ellipsis at 360dp',
        );
        expect(
          tester.getTopRight(chip).dx,
          lessThanOrEqualTo(360.0),
          reason: 'chip label for $tag ran off the right edge of a 360dp '
              'screen — the Wrap stopped wrapping',
        );
      }

      // Lay out the REST of the page (the about and update cards sit below
      // the preferences card the chip loop stopped at) so the zero-overflow
      // assertion covers the whole page, not just the part above the last
      // chip.
      for (int i = 0; i < 20; i++) {
        await tester.drag(find.byType(ListView), const Offset(0, -400));
        await tester.pumpAndSettle();
      }
      // Restore BEFORE the expect: a failing expect while onError is still
      // overridden trips the binding's own assertion and wedges the runner
      // for pumpAndSettle's full 10-minute timeout (measured on this very
      // assertion's first red).
      FlutterError.onError = prevOnError;
      expect(
        pageOverflows,
        isEmpty,
        reason: 'the settings page must lay out at 360dp with zero RenderFlex '
            'overflows — an overflowed row shows the user a striped stub '
            'instead of the copy (0.2.53 law: assert the rendered result)',
      );
    });
  });
}
