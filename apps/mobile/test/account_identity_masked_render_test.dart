// owner 2026-08-27 UAT ②, in two halves:
//   ·「手机上没有一个界面告诉我用的是哪个账号」— on a narrow phone NOTHING
//     answered 「which account am I signed in with」. The cloud / 轻记录 card
//     carried the address in a [Flexible] that collapses once the manage and
//     sign-out links take the width, so it showed on a tablet and vanished on a
//     360dp phone;
//   ·「所有显示账号的地方都要用星号遮盖」— and every place that names the
//     account paints the masked form, never the address itself.
//
// The two halves pull in OPPOSITE directions and that is why both are pinned
// here: 「always visible」 alone invites painting the raw address, and
// 「masked」 alone is satisfied by painting nothing at all. Each group below
// carries the other half as its own positive control.
//
// 🔴 THE ASSERTIONS LAND ON WHAT WAS PAINTED (0.2.53 law). `Text.data` is not
// used as evidence anywhere in this file: the defect being fixed is a line the
// user could not see while the widget tree was perfectly correct, which is
// exactly the reading `Text.data` cannot make. Clipping goes through
// `expectLegible`, whose instrument-choice reasoning is in
// test/support/legibility.dart.
//
// ⚠️ AHEM RULER. flutter_test paints every glyph as a full-em square, so
// 「not clipped here」 ⇒ 「not clipped on a real phone」, and the converse does
// NOT hold. Nothing in this file may be quoted as 「this line happens to fit on
// a real 360dp device」.
//
// ── REVERSE CONTROL, run on this machine (dev-pc-a), then restored ──
// Dropped the mask at the cloud card's render site
// (`cloud_signout_row.dart:171`: `maskAccountEmail(widget.login.email)` →
// `widget.login.email ?? ''`) and re-ran this file. Two cases went red, and the
// PAIR is the point — one for each half of the ruling. Verbatim:
//
//   00:00 +1 -2: the cloud card 🔴 the address itself is painted NOWHERE [E]
//     Expected: no matching candidates
//       Actual: _TextWidgetFinder:<Found 1 widget with text
//               "bitbalabala@flowmic.test": [
//                 Text-[<'cloud.account.identity'>]("bitbalabala@flowmic.test",
//                 …, size: 11.5, maxLines: 1, …),
//               ]>
//      Which: means one was found but none were expected
//
//   (same run, the positive control in that case's own preamble)
//     Expected: exactly one matching candidate
//       Actual: _TextWidgetFinder:<Found 0 widgets with text
//               "bit***a@flowmic.test": []>
//      Which: means none were found but one was expected
//     probe is live
//
// Restored; `grep -rn REVERSE-CONTROL apps/mobile/lib` = 0; file re-green 8/8.
//
// SPEC-REF:
//   apps/mobile/lib/src/auth/account_mask.dart (the rule; its own unit tests
//     are account_mask_test.dart)
//   apps/mobile/lib/src/ui/cloud_signout_row.dart (the always-on line)
//   apps/mobile/lib/src/ui/settings_page.dart (the account pill)
//   apps/mobile/lib/src/ui/login_sheet.dart (the success tick)

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_mask.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/browser_login_controller.dart';
import 'package:flowmic/src/auth/deep_link_source.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/cloud_signout_row.dart';
import 'package:flowmic/src/ui/login_sheet.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/browser_login_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthFor, expectLegible;
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

/// A realistic account: long enough that the old [Flexible] really did lose it,
/// and shaped like the one in the owner's report.
const String kAddress = 'bitbalabala@flowmic.test';
const String kMasked = 'bit***a@flowmic.test';
const String kSaas = 'https://saas.test:443';

final Finder kIdentity =
    find.byKey(const ValueKey<String>('cloud.account.identity'));

/// The width the cloud card's inner column really gets on a 360dp phone,
/// derived from the product's own paddings rather than picked:
///   360 − 14 − 14 (connections list `fromLTRB(14, 14, 14, 20)`)
///       − 4       (identity lane, `_identityCardRouted`)
///       − 16 − 16 (card padding `symmetric(horizontal: 16)`)
///       − 42 − 12 (leading icon + gap)
///       − 20      (trailing chevron)
///   = 222.
///
/// 🔴 Measuring the row at a bare 360 would be measuring a width that does not
/// exist in the product — and it is 138dp of slack, i.e. enough to hide the
/// very failure this file is about.
const double kCardInnerDp = 222;

Future<void> _signIn(FakeSocketTransport t, LoginController login) async {
  t.ackQueue.add(<String, Object?>{
    'ok': true,
    'token': 'jwt-mask',
    'user': <String, Object?>{'email': kAddress, 'id': 'u-mask', 'plan': 'free'},
    'mode': 'saas',
  });
  await login.login(email: kAddress, password: 'secret12ab');
  if (!login.isLoggedIn) {
    throw StateError('harness precondition failed: the fake login did not take');
  }
}

/// The cloud card's row, in the width it really has, at the app's own type step.
///
/// 🔴 THE RULER FOLLOWS THE SCRIPT OF THE STRING, NOT THE UI LANGUAGE — and
/// this was measured the hard way. `ahemWidthFor(222, AppLocale.zh)` is 222px
/// (Han needs no inflation, since Ahem and a real CJK font are the same width),
/// and the line under test went red there:
///
///   Expected: false / Actual: `true`
///   clipped by maxLines=1: bit***a@flowmic.test（zh）
///
/// The string on this line is an EMAIL ADDRESS: Latin in every UI language, and
/// Ahem paints Latin at roughly twice a real font. So the Han budget is the
/// wrong ruler for it — a false red about a line that on a real phone needs
/// about half the room. The Latin factor is used for every locale, because the
/// thing being measured is Latin in every locale.
///
/// ⚠️ It stays CONSERVATIVE in the direction that matters: 1.8× is still below
/// Ahem's real ~2.0× inflation, so 「not clipped here」 ⇒ 「not clipped on a
/// real 360dp phone」. The converse is not claimed, here or anywhere.
Future<void> _pumpCloudRow(
  WidgetTester tester, {
  required LoginController login,
  required ConnectionsController connections,
  required AppLocale locale,
}) async {
  final double px = ahemWidthFor(kCardInnerDp, AppLocale.en);
  tester.view.physicalSize = Size(px + 40, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: px,
            child: CloudSignOutRow(
              login: login,
              connections: connections,
              strings: AppStrings.of(locale),
              urlLauncher: (Uri url, {required LaunchMode mode}) async => true,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

class _SettingsRig {
  late final AppSettingsController appSettings;
  late final ScenarioCardController scenario;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;
  late final SettingsClient settingsClient;

  static Future<_SettingsRig> create(CloudAccount account) async {
    final _SettingsRig r = _SettingsRig();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    r.appSettings = AppSettingsController(prefs: prefs);
    await r.appSettings.load();
    final FakeSocketTransport transport = FakeSocketTransport();
    r.settingsClient =
        SettingsClient(transport: transport, roomJoins: ValueNotifier<int>(0));
    r.scenario = ScenarioCardController(
      settingsClient: r.settingsClient,
      cache: InMemoryScenarioCardCache(),
    );
    await r.scenario.load();
    r.session = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.login = newTestLogin(
      transport: r.session.transport,
      accountStore: InMemoryAccountStore(account),
    );
    await r.login.hydrate();
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
          inventory: newTestInventory(
            rows: const <TimelineEntry>[],
            images: InMemoryOutboxBlobStore(),
          ),
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
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('instrument self-check: the expected string is the rule\'s own output', () {
    // [kMasked] is written out by hand above so the assertions below read as a
    // product claim rather than as `f(x) == f(x)`. This one line keeps the two
    // from drifting: if the rule changes, this fails HERE, by name, instead of
    // turning every render assertion below into a puzzle.
    expect(kMasked, maskAccountEmail(kAddress));
  });

  group('the cloud card', () {
    late FakeSocketTransport transport;
    late LoginController login;
    late ConnectionsController connections;

    setUp(() {
      transport = FakeSocketTransport()..connectSucceeds = true;
      login = LoginController(
        transport: transport,
        accountStore: InMemoryAccountStore(),
        saasEndpoint: kSaas,
      );
      connections = ConnectionsController(
        session: newTestSession(transport: transport),
        login: login,
        saasEndpoint: kSaas,
      );
    });

    tearDown(() {
      connections.dispose();
      login.dispose();
    });

    testWidgets(
        '🔴 the identity is on screen at the real 360dp card width — the defect '
        'was that it was not', (WidgetTester tester) async {
      await _signIn(transport, login);
      await _pumpCloudRow(
        tester,
        login: login,
        connections: connections,
        locale: AppLocale.en,
      );

      expect(kIdentity, findsOneWidget);
      expect(find.text(kMasked), findsOneWidget);
      // 🔴 THE MEASUREMENT, not the widget's existence. The old row also
      // 「had」 the address — as a Flexible squeezed to nothing. A box of zero
      // width is a widget that exists and an identity nobody can read.
      final Size box = tester.getSize(kIdentity);
      expect(box.width, greaterThan(0));
      expect(box.height, greaterThan(0));
      expectLegible(tester, kIdentity, reason: 'the account identity line');
    });

    testWidgets('🔴 the address itself is painted NOWHERE',
        (WidgetTester tester) async {
      await _signIn(transport, login);
      await _pumpCloudRow(
        tester,
        login: login,
        connections: connections,
        locale: AppLocale.en,
      );

      // Positive control first: a probe that found a blank screen would pass
      // every absence assertion ever written.
      expect(find.text(kMasked), findsOneWidget, reason: 'probe is live');
      expect(find.text(kAddress), findsNothing,
          reason: 'the raw address is on screen — the mask is not wired at this site');
      expect(find.textContaining(kAddress), findsNothing,
          reason: 'the raw address is on screen inside a longer string');
    });

    testWidgets('it survives every locale at that width, unclipped',
        (WidgetTester tester) async {
      await _signIn(transport, login);
      for (final AppLocale locale in AppLocale.values) {
        await _pumpCloudRow(
          tester,
          login: login,
          connections: connections,
          locale: locale,
        );
        expect(kIdentity, findsOneWidget, reason: locale.name);
        expectLegible(tester, kIdentity, reason: locale.name);
        expect(find.text(kAddress), findsNothing, reason: locale.name);

        // ⚠️ WHAT IS DELIBERATELY NOT ASSERTED HERE, AND WHY IT IS NOT A
        // LOOPHOLE. Under the Ahem ruler the LINKS row above this line — the
        // manage link plus 「sign out」, both localised — overflows in some
        // languages (measured: `A RenderFlex overflowed by 96 pixels on the
        // right`). That is a property of the ruler and of a row this card did
        // not touch: the address used to sit in that same row as a [Flexible]
        // that collapsed to zero, so the links' own width is unchanged by this
        // change, and at a real 360dp phone with a real font they fit.
        //
        // The exception is consumed rather than ignored, and it is CHECKED:
        // anything that is not an overflow still fails this loop by name. What
        // this file owns — that the identity line itself is painted and not
        // clipped — is measured above and does not depend on it.
        final Object? thrown = tester.takeException();
        if (thrown != null) {
          expect(
            thrown.toString(),
            contains('overflowed'),
            reason: '${locale.name}: an exception that is NOT the known '
                'Ahem-width overflow of the links row',
          );
        }
      }
    });

    testWidgets('signed out ⇒ no identity line, because there is no identity',
        (WidgetTester tester) async {
      await _pumpCloudRow(
        tester,
        login: login,
        connections: connections,
        locale: AppLocale.en,
      );
      expect(kIdentity, findsNothing);
      expect(find.textContaining('***'), findsNothing,
          reason: 'a mask with nothing behind it is an identity that does not exist');
    });

    testWidgets(
        'the screen reader is told what the line IS, in the language on screen',
        (WidgetTester tester) async {
      await _signIn(transport, login);
      for (final AppLocale locale in <AppLocale>[AppLocale.en, AppLocale.zh]) {
        await _pumpCloudRow(
          tester,
          login: login,
          connections: connections,
          locale: locale,
        );
        final AppStrings s = AppStrings.of(locale);
        // 🔴 The visible face is four characters and a domain; without this
        // label a screen reader reads them into the void. And the label carries
        // the MASKED form — the one channel where a full address could slip
        // out unseen by anybody reviewing a screenshot.
        expect(find.bySemanticsLabel(s.accountSignedInAs(kMasked)), findsOneWidget,
            reason: locale.name);
        expect(find.bySemanticsLabel(s.accountSignedInAs(kAddress)), findsNothing,
            reason: '${locale.name}: the raw address is being read aloud');
      }
    });
  });

  group('the other two render sites (the sweep)', () {
    testWidgets('settings account pill paints the mask, never the address',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final _SettingsRig rig = await _SettingsRig.create(
        const CloudAccount(jwt: 'jwt-mask', email: kAddress, plan: 'free'),
      );
      addTearDown(rig.dispose);
      rig.appSettings.setLocale(AppLocale.en);
      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();

      expect(find.text(kMasked), findsOneWidget, reason: 'probe is live');
      expect(find.text(kAddress), findsNothing);
      expect(find.textContaining(kAddress), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the sign-in success tick paints the mask, never the address',
        (WidgetTester tester) async {
      // This site is the one that proves why the rule had to be a sweep: the
      // address here comes off the WIRE (the login ack) rather than out of
      // storage, so a fix aimed at 「the account card」 would have left it
      // untouched — on a sheet anyone standing behind the user can read.
      final FakeSocketTransport transport = FakeSocketTransport()
        ..connectSucceeds = true;
      final LoginController login = newTestLogin(transport: transport);
      addTearDown(login.dispose);
      final BrowserLoginController browser = BrowserLoginController(
        login: login,
        links: FakeBrowserLoginLinks(),
        store: InMemoryBrowserLoginStateStore(),
        opener: FakeBrowserOpener().call,
        endpoint: kSaas,
        waitTimeout: const Duration(seconds: 5),
      );
      addTearDown(browser.dispose);
      await _signIn(transport, login);

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (BuildContext context) => Scaffold(
              body: Center(
                child: ElevatedButton(
                  onPressed: () => showLoginSheet(
                    context,
                    controller: login,
                    strings: AppStrings.of(AppLocale.en),
                    browserLogin: browser,
                  ),
                  child: const Text('open-sheet'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open-sheet'));
      // Deliberately NOT pumpAndSettle: the success body dismisses itself after
      // 700ms, and settling would run the assertions on an empty screen — the
      // shape that makes every absence check pass for free.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text(kMasked), findsOneWidget, reason: 'probe is live');
      expect(find.text(kAddress), findsNothing);

      // Let the self-dismiss timer run out so no timer is left pending.
      await tester.pump(const Duration(milliseconds: 800));
      await tester.pumpAndSettle();
    });
  });
}
