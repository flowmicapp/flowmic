// 2026-09-03 (WP-B items 1 + 5) — the 「Recognition and AI」 card and the two
// settings-backup rows, rendered over the REAL controllers (fake socket) on a
// REAL SettingsPage.
//
// What each case proves, and why it is a WIDGET test (anti-façade ③ / ⑥ —
// 「the two ends were each tested, the middle was never walked」):
//   · a switch tap reaches the value the transcription request will carry —
//     not 「the controller has a setter」. 🔴 Since owner's 2026-09-03
//     follow-up ruling the tap puts NOTHING on a wire: the row is read out of
//     the controller when `audio:start` / `compose:start` is built, and the
//     hop from 「the controller holds it」 to 「the frame carries it」 is walked
//     in phone_prefs_payload_test.dart over a real ChatController. Each case
//     below therefore asserts the held row's exact wire SHAPE and that the
//     transport stayed silent — two halves that together are the whole path;
//   · the strength chips exist only while polish is on;
//   · the consent sentence is RENDERED un-clipped at 360dp in every locale
//     (0.2.53 law: the user reads the layout, not `Text.data`), because that
//     sentence IS the consent;
//   · the backup rows reach the port (a count, not a presence check);
//   · the add-term dialog's alias field lands aliases on the card and the row
//     shows them.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/prefs_controller.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show EventEnvelope;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

class _Rig {
  late final FakeSocketTransport transport;
  late final SettingsClient client;
  late final ScenarioCardController scenario;
  late final PrefsController prefs;
  late final FakeSettingsBackup backup;
  late final AppSettingsController appSettings;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;

  static Future<_Rig> create({AppLocale locale = AppLocale.en}) async {
    final _Rig r = _Rig();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences sp = await SharedPreferences.getInstance();
    r.appSettings = AppSettingsController(prefs: sp);
    await r.appSettings.load();
    r.appSettings.setLocale(locale);
    r.transport = FakeSocketTransport();
    r.client = SettingsClient(transport: r.transport, roomJoins: ValueNotifier<int>(0));
    r.scenario = ScenarioCardController(cache: InMemoryScenarioCardCache());
    await r.scenario.load();
    r.prefs = newTestPrefsController();
    await r.prefs.load();
    r.backup = newTestSettingsBackup();
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
          portable: newTestPortableController(),
          prefs: prefs,
          backup: backup,
          inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
          timeline: newTestStore(),
          version: const FixedAppVersion('0.0.0-test'),
          update: newTestUpdateController(),
          cloudSummary: newTestCloudSummary(login: login),
        ),
      );

  AppStrings get s => AppStrings.of(appSettings.locale);

  /// Everything this page put on the socket. Used as a NEGATIVE probe: the
  /// settings screen has had no wire since 2026-09-03, and asserting on the
  /// whole transport (rather than on one event name) is the only form of that
  /// claim worth anything (G13 rule 1).
  List<EventEnvelope> emitted() => transport.emitted;

  Future<void> dispose() async {
    prefs.dispose();
    scenario.dispose();
    await client.dispose();
    login.dispose();
    appSettings.dispose();
    destination.dispose();
    await session.dispose();
    await transport.close();
  }
}

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360 * 3, 800 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

Future<void> _scrollTo(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('polish switch → stt.polish on the wire; the strength chips exist only while it is on',
      (WidgetTester tester) async {
    _phone(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    final Finder polish = find.byKey(const ValueKey<String>('settings.polish.switch'));
    await _scrollTo(tester, polish);
    expect(find.text(rig.s.polishStrict), findsOneWidget, reason: 'on by default ⇒ chips shown');

    await tester.tap(polish);
    await tester.pumpAndSettle();
    expect(rig.prefs.prefs.polish!.toJson(),
        <String, Object?>{'enabled': false, 'strength': 'strict'});
    expect(find.text(rig.s.polishStrict), findsNothing,
        reason: 'a strength for a layer that is not running would be a control that changes nothing');

    await tester.tap(polish);
    await tester.pumpAndSettle();
    await _scrollTo(tester, find.text(rig.s.polishSmooth));
    await tester.tap(find.text(rig.s.polishSmooth));
    await tester.pumpAndSettle();
    expect(rig.prefs.prefs.polish!.toJson(),
        <String, Object?>{'enabled': true, 'strength': 'smooth'});
    expect(rig.emitted(), isEmpty,
        reason: 'the settings screen has no wire: the value is read out of the '
            'controller when the next audio:start is built');
  });

  testWidgets('refine and consent switches → their keys on the wire, exact shapes', (WidgetTester tester) async {
    _phone(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    final Finder refine = find.byKey(const ValueKey<String>('settings.refine.switch'));
    await _scrollTo(tester, refine);
    await tester.tap(refine);
    await tester.pumpAndSettle();
    expect(rig.prefs.prefs.refine!.toJson(), <String, Object?>{'enabled': true});

    final Finder consent = find.byKey(const ValueKey<String>('settings.inference.switch'));
    await _scrollTo(tester, consent);
    await tester.tap(consent);
    await tester.pumpAndSettle();
    expect(rig.prefs.prefs.inference!.toJson(),
        <String, Object?>{'granted': true, 'granted_for': 'external'});
    expect(rig.emitted(), isEmpty);
  });

  testWidgets('0.2.53 law — in every locale at 360dp the consent sentence and the three '
      'titles RENDER un-clipped, and the rows this card adds lay out with zero overflows', (WidgetTester tester) async {
    _phone(tester);
    // ⚠️ SCOPED to the rows this package wrote (settings_general_prefs.dart +
    // the settingsSwitchRow primitive), by the creator location Flutter prints
    // with every overflow. Measured 2026-09-03 while writing this: walking the
    // WHOLE page in nine locales at 360dp also trips three PRE-EXISTING rows
    // that no gate had ever laid out outside `en` — the theme row
    // (settings_preferences.dart, `Row[Expanded(title), chip×3]`) by 13px in
    // fr/es and 62px in ru, and the custom-terms header row
    // (settings_custom_terms.dart, title + counter) by 23px in es. Those are
    // real defects and are reported, not fixed here: pinning them into this
    // card's assertion would make a green here mean two things. The whole-page
    // `en` assertion stays where it was (spoken_language_test.dart).
    final List<String> overflows = <String>[];
    final List<String> preExisting = <String>[];
    final void Function(FlutterErrorDetails)? prev = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails d) {
      if (d.exceptionAsString().contains('overflowed')) {
        final String where = d.toString();
        (where.contains('settings_general_prefs.dart') || where.contains('settings_widgets.dart')
                ? overflows
                : preExisting)
            .add(d.exceptionAsString());
        return;
      }
      prev?.call(d);
    };
    addTearDown(() => FlutterError.onError = prev);

    for (final AppLocale locale in AppLocale.values) {
      final _Rig rig = await _Rig.create(locale: locale);
      // ⚠️ Disposed in tearDown, NOT awaited inside the body: a testWidgets
      // body runs under FakeAsync, and `session.dispose()` awaits real timers
      // that never fire there — measured 2026-09-03 as a run that printed the
      // same test name for six minutes with no output (the repo's known
      // 「hangs without output, looks slow not broken」 shape).
      addTearDown(rig.dispose);
      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();
      final AppStrings s = rig.s;
      for (final String copy in <String>[s.polishTitle, s.refineTitle, s.inferenceTitle, s.inferenceSub, s.polishStrengthNote]) {
        final Finder f = find.text(copy);
        await _scrollTo(tester, f);
        expect(f, findsOneWidget, reason: '$locale: 「$copy」 did not render');
        expect(tester.renderObject<RenderParagraph>(f).didExceedMaxLines, isFalse,
            reason: '$locale: 「$copy」 was cut by an ellipsis at 360dp');
        expect(tester.getBottomRight(f).dx, lessThanOrEqualTo(360.0),
            reason: '$locale: 「$copy」 ran off the right edge');
      }
      for (int i = 0; i < 20; i++) {
        await tester.drag(find.byType(ListView), const Offset(0, -400));
        await tester.pumpAndSettle();
      }
      await tester.pumpWidget(const SizedBox());
    }
    FlutterError.onError = prev;
    expect(overflows, isEmpty, reason: 'an overflowed row shows a striped stub instead of the copy');
  });

  testWidgets('the backup rows reach the port — a tap is counted, and a cancel says cancelled',
      (WidgetTester tester) async {
    _phone(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    final Finder exportBtn = find.byKey(const ValueKey<String>('settings.backup.export'));
    await _scrollTo(tester, exportBtn);
    await tester.tap(exportBtn);
    await tester.pumpAndSettle();
    expect(rig.backup.exportCalls, 1);
    expect(find.text(rig.s.settingsBackupCancelled), findsOneWidget,
        reason: 'the double cancelled, so the page must say cancelled — never 「saved」');
    // Let the first snack bar time out (6 s) or the second one queues behind it
    // and 「Restore cancelled」 is never on screen while this test looks.
    await tester.pump(const Duration(seconds: 7));
    await tester.pumpAndSettle();

    final Finder importBtn = find.byKey(const ValueKey<String>('settings.backup.import'));
    await _scrollTo(tester, importBtn);
    await tester.tap(importBtn);
    await tester.pumpAndSettle();
    expect(rig.backup.importCalls, 1);
    expect(find.text(rig.s.settingsRestoreCancelled), findsOneWidget);
  });

  testWidgets('add-term dialog: the alias field lands aliases on the card and the row shows them',
      (WidgetTester tester) async {
    _phone(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    final Finder add = find.text(rig.s.addTerm);
    await _scrollTo(tester, add);
    await tester.tap(add);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'FlowMic');
    await tester.enterText(find.byKey(const ValueKey<String>('settings.term.aliases')), 'flow mic, flomic');
    await tester.tap(find.text(rig.s.add));
    await tester.pumpAndSettle();

    expect(rig.scenario.card.terms.single,
        const ScenarioTerm('FlowMic', aliases: <String>['flow mic', 'flomic']));
    expect(find.text(rig.s.termAliasesLabel('flow mic, flomic')), findsOneWidget);
    expect(rig.scenario.card.toJson()['terms'], <Object>[
      <String, Object?>{'term': 'FlowMic', 'aliases': <String>['flow mic', 'flomic']},
    ], reason: 'exactly the ScenarioCardSchema JSON the bundle carries');
    expect(rig.emitted(), isEmpty);
  });
}
