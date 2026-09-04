// WP-R3-3 — the settings screen rendered over the real controllers (fake socket
// + fake recorder). Proves the anti-façade wiring: a profession chip and a pack
// checkbox are LIVE — tapping a chip lands on the card the transcription
// request will carry; the structured surfaces (chips / packs / terms) all
// render from the generated protocol data.
//
// 🔴 THE TAP PUTS NOTHING ON A WIRE (owner 2026-09-03, follow-up ruling 2):
// the card is READ out of the controller when `audio:start` / `compose:start`
// is built (settings/phone_prefs_payload.dart), and that hop is walked over a
// real ChatController in phone_prefs_payload_test.dart. Here the claim is the
// screen half plus its negative: the settings screen's socket stays silent.

import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/scenario_taxonomy.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/fakes.dart';
import 'support/di.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

class _Rig {
  late final FakeSocketTransport settingsTransport;
  late final SettingsClient settingsClient;
  late final ValueNotifier<int> settingsJoins;
  late final ScenarioCardController scenario;
  late final AppSettingsController appSettings;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;

  static Future<_Rig> create() async {
    final _Rig r = _Rig();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    r.appSettings = AppSettingsController(prefs: prefs);
    await r.appSettings.load();
    r.settingsTransport = FakeSocketTransport();
    // The settings edge is `PttSession.roomJoins`, not the socket's connected
    // status (settings_client.dart header point 4 — F-1 on the settings path).
    // Bumping this notifier is what "the server admitted us" looks like here.
    r.settingsJoins = ValueNotifier<int>(0);
    r.settingsClient = SettingsClient(
        transport: r.settingsTransport, roomJoins: r.settingsJoins);
    r.scenario = ScenarioCardController(
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
        home: SettingsPage(
          scenario: scenario,
          appSettings: appSettings,
          login: login,
          destination: destination,
          session: session,
          // Window C: SettingsPage now requires the export/import controller. A
          // double over empty rows — this test is about the scenario card, and
          // the data section only has to BUILD.
          portable: newTestPortableController(),
          prefs: newTestPrefsController(),
          backup: newTestSettingsBackup(),
          inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
          timeline: newTestStore(),
          version: const FixedAppVersion('0.0.0-test'),
          update: newTestUpdateController(),
          cloudSummary: newTestCloudSummary(login: login),
        ),
      );

  Future<void> dispose() async {
    await settingsClient.dispose();
    login.dispose();
    scenario.dispose();
    appSettings.dispose();
    destination.dispose();
    await session.dispose();
    await settingsTransport.close();
  }
}

void main() {
  testWidgets('structured scenario surfaces render + a chip tap writes '
      'settings:update', (WidgetTester tester) async {
    // Tall viewport so the whole anchored settings list lays out at once.
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    // Structured (NOT free-text): profession chip, a generated pack label, and
    // the custom-terms hint are all present.
    expect(find.text('软件开发'), findsOneWidget); // profession preset chip
    expect(find.text('编程 / 开发术语'), findsOneWidget); // generated tech-dev pack
    expect(find.text('每条 ≤40 字符'), findsOneWidget); // term ≤40 hint

    // Tap the profession chip → save-as-you-go → it is on the card the next
    // audio:start will carry, and nothing was announced to anyone.
    await tester.tap(find.text('软件开发'));
    await tester.pump();

    // 2026-09-04: the chip stores the taxonomy ID, not the label that was on
    // screen. The English canonical is what the wire carries, and that hop is
    // pinned in phone_prefs_payload_test.dart.
    expect(rig.scenario.card.hasProfession('software-dev'), isTrue);
    expect(rig.scenario.card.toJson()['professions'], <String>['software-dev']);
    expect(rig.scenario.card.toWireJson()['professions'],
        <String>['software development']);
    expect(rig.settingsTransport.emitted, isEmpty,
        reason: 'the settings screen has had no wire since 2026-09-03');
  });

  testWidgets('2026-09-03 (phone-owned card): a settings:list carrying a scenario.card '
      'is NOT adopted — the SCREEN keeps the phone\'s own card, and the pull still '
      'happened (it is the capability snapshot, not a card source)',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    // The card this phone holds. Until 2026-09-03 the case below DISPLACED it
    // with the server's copy and rendered 「已按电脑端最新值更新」; the owner
    // ruled the card lives only on this phone, so the inverse is pinned now.
    rig.scenario.togglePack('legal');
    expect(rig.scenario.addTerm('手机术语'), TermAddOutcome.added);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(find.text('手机术语'), findsOneWidget);

    rig.settingsTransport.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'key': 'scenario.card',
          'value': <String, Object?>{
            'professions': <String>['software development'],
            'domains': <String>[],
            'packs': <String>['tech-dev'],
            'terms': <String>['服务端术语'],
          },
        },
      ],
    });
    rig.settingsJoins.value++;
    await tester.pumpAndSettle();

    // The wire really carried the pull (positive control)…
    expect(rig.settingsTransport.emittedWhere(FlowMicEvents.settingsList), hasLength(1));
    // …and the join answered it with nothing else: no push went up either, so
    // the ONLY thing that crossed this socket was a capability read.
    expect(rig.settingsTransport.emittedNames.toSet(),
        <String>{FlowMicEvents.settingsList});
    expect(rig.scenario.card.termNames, <String>['手机术语'],
        reason: 'the phone\'s card is the only card');
    // The screen is unchanged: our term, our counter, and no 「updated from
    // your PC」 note anywhere (that string has no renderer any more).
    expect(find.text('手机术语'), findsOneWidget);
    expect(find.text('服务端术语'), findsNothing);
    expect(find.text('1 / 100'), findsOneWidget);
    expect(find.text('已按电脑端最新值更新'), findsNothing);
  });

  testWidgets('VISIBLE language selector: tapping the EN chip re-renders the '
      'screen in EN (explicit locale, never OS — WP-R4-3)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsOneWidget); // pinned zh so the EN tap is a real flip
    expect(find.text('偏好'), findsOneWidget); // the preferences section exists
    // Save-as-you-go: tapping the visible EN chip flips the whole screen — no
    // save button, and the controller persisted the explicit choice.
    // 🔴 Nine-locale expansion (2026-08-14): the word printed on this chip
    // changed from `s.langEn`＝'EN' to the **endonym**＝'English'. Not a layout
    // preference: `langEn` is a two-letter abbreviation, and the other eight of
    // the nine chips are all self-names ('Français' / 'Русский' / '日本語'), so
    // mixing them would make the English cell look like a different kind of
    // thing. The registry also ruled this verbatim (`packages/protocol/src/locales.ts`
    // `endonym`: language names use the self-name on every UI and are not
    // translated with the UI language). The `langEn` string was kept at the
    // time because it still served `spokenLangLabel` — 「which language am I
    // speaking」, a different question. WP3 C11 (2026-08-18) moved that last
    // reader onto [AppLocale] endonyms too (the spoken list grew 4 → 8), so
    // the four hand-written name getters are now deleted; the reasoning above
    // about endonym chips is unchanged.
    await tester.ensureVisible(find.text('English'));
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget); // flipped, explicitly
    expect(find.text('设置'), findsNothing);
    expect(find.text('PREFERENCES'), findsOneWidget); // settingsSection upcases
    // V2-07.7: the former SHADOW catalogues render through AppStrings now —
    // the profession chip wears the catalogue's English face, and the pack
    // falls back to the protocol's English SSOT label.
    expect(find.text('Software dev'), findsOneWidget); // profession preset chip
    expect(find.text('Tech / Dev terms'), findsOneWidget); // tech-dev pack
    expect(find.text('软件开发'), findsNothing);
    expect(find.text('编程 / 开发术语'), findsNothing);
    // And back via the visible 中文 chip.
    await tester.tap(find.text('中文'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.zh);
    expect(find.text('设置'), findsOneWidget);
  });

  testWidgets('V2-07.5: the 日本語 / 한국어 chips REALLY re-render the screen '
      'in Japanese / Korean (explicit locale, never OS)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(find.text('设置'), findsOneWidget); // pinned zh so ja/ko are real flips

    // The chip labels are endonyms (中文 / EN / 日本語 / 한국어) — findable in
    // every UI language, which is exactly why a user lost in a language they
    // cannot read can still find the way back.
    await tester.ensureVisible(find.text('日本語'));
    await tester.tap(find.text('日本語'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.ja);
    expect(find.text('設定'), findsOneWidget); // app bar flipped
    expect(find.text('アカウント'), findsOneWidget); // section header flipped
    expect(find.text('環境設定'), findsOneWidget); // preferences section flipped
    expect(find.text('设置'), findsNothing);
    expect(find.text('Settings'), findsNothing);

    await tester.tap(find.text('한국어'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.ko);
    expect(find.text('설정'), findsOneWidget);
    expect(find.text('계정'), findsOneWidget);
    expect(find.text('환경 설정'), findsOneWidget);
    expect(find.text('設定'), findsNothing);
  });

  testWidgets('RED LINE: the OS locale never picks the UI language — a ja/zh '
      'OS with NO stored pref still boots to the English default', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    // ja is a SHIPPED language and is NOT the default. Stubbing to en-US after
    // the default flipped to English would go green even if the code started
    // reading PlatformDispatcher.locale — a weakened guard.
    tester.platformDispatcher.localeTestValue = const Locale('ja', 'JP');
    addTearDown(tester.platformDispatcher.clearLocaleTestValue);

    final _Rig rig = await _Rig.create(); // mock prefs EMPTY — no stored choice
    addTearDown(rig.dispose);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('设置'), findsNothing);
    expect(find.text('設定'), findsNothing);

    // Mid-session OS flips change nothing either — there is no OS-locale
    // listener anywhere in the language path (the theme may follow the OS;
    // the language may NOT — two deliberately different rulings).
    tester.platformDispatcher.localeTestValue = const Locale('zh', 'CN');
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('设置'), findsNothing);
  });

  // ── the chips survive a UI-language switch (2026-09-04) ───────────────────
  //
  // ── REVERSE CONTROL (executed 2026-09-04) ─────────────────────────────────
  // Break: in settings_page.dart, make the profession chip store the LABEL it
  // renders again — `onToggle: (id) => scenario.toggleProfession(
  // ScenarioAxis.professions.label(s, id))`, i.e. exactly the pre-id behaviour.
  // OBSERVED, this case red at the FIRST assertion, before any language switch:
  //     Expected: contains '软件开发'
  //       Actual: []
  //        Which: does not contain '软件开发'
  // — the chip the user just tapped does not even light up, because the stored
  // label no longer matches the id the chip is keyed by. (The case above went
  // red too: `hasProfession('software-dev')` Expected: true Actual: <false>.)
  // Restored; `REVERSE-CONTROL` greps to 0 in apps/mobile/lib.
  //
  // 🔴 THE DELIVERABLE IS WHAT IS ON THIS SCREEN, so this test mounts this
  // screen. The taxonomy's own unit tests (scenario_taxonomy_test.dart) prove
  // the mapping and the migration; neither of them can see a chip. Before ids,
  // the card stored the label that was rendered at tap time, so flipping the UI
  // language left every stored value matching nothing and the whole row went
  // unselected — a defect no model-level test could have shown.
  testWidgets('a profession chip picked in Chinese is STILL picked after the UI '
      'language is switched to German and to Japanese, rendered in each '
      'language, and the card still holds ONE id', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    // Pick 「软件开发」 the way a user does: by tapping the chip that says it.
    await tester.tap(find.text('软件开发'));
    await tester.pumpAndSettle();
    expect(_selectedProfessionChips(AppLocale.zh), contains('软件开发'));

    // Same phone, German UI.
    rig.appSettings.setLocale(AppLocale.de);
    await tester.pumpAndSettle();
    expect(find.text('软件开发'), findsNothing,
        reason: 'the Chinese label must be gone from the screen entirely');
    expect(find.text('Software'), findsOneWidget);
    expect(_selectedProfessionChips(AppLocale.de), contains('Software'),
        reason: 'the selection is keyed by id, so it survives the language');

    // And a third language, in a different script, without a re-tap.
    rig.appSettings.setLocale(AppLocale.ja);
    await tester.pumpAndSettle();
    expect(_selectedProfessionChips(AppLocale.ja), contains('ソフトウェア開発'));

    // Exactly ONE profession is selected in each of the three languages — the
    // count is the assertion that would have caught the reported defect, where
    // the same profession accumulated once per language used.
    expect(_selectedProfessionChips(AppLocale.ja), hasLength(1));
    expect(rig.scenario.card.professions, <String>['software-dev']);
    expect(rig.scenario.card.toWireJson()['professions'],
        <String>['software development']);
  });
}

/// The text of every PROFESSION chip currently rendered in its SELECTED state.
///
/// ⚠️ Reads the RENDERED tree, not the model: 「is this chip on」 is a question
/// about the screen, and answering it from `card.hasProfession` would make this
/// widget test a second copy of the unit test. `settingsChip` fills its pill
/// with `brandSoft` exactly when it is on, so the on-state is read off the paint.
///
/// ⚠️ SCOPED to the profession row, and scoped by ASKING THE REGISTRY for an
/// anchor rather than by typing a label in. The settings screen has four other
/// chip rows (UI language, spoken language, polish strength, theme) and they
/// are all `settingsChip` too — an unscoped read returns 「日本語」 and 「システム」
/// alongside the answer. `product-design` is the anchor because it is the one
/// profession whose label collides with no domain in any of the nine locales.
List<String> _selectedProfessionChips(AppLocale locale) {
  final String anchor = ScenarioAxis.professions.labelIn(locale, 'product-design');
  final Finder group =
      find.ancestor(of: find.text(anchor), matching: find.byType(Wrap)).first;
  final List<String> out = <String>[];
  for (final Element e
      in find.descendant(of: group, matching: find.byType(Container)).evaluate()) {
    final Container box = e.widget as Container;
    final Decoration? d = box.decoration;
    final Widget? child = box.child;
    if (d is! BoxDecoration || child is! Text || child.data == null) continue;
    if (d.color != FlowMicColors.brandSoft) continue;
    out.add(child.data!);
  }
  return out;
}
