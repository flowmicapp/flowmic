// The shared instrument for the text-size card: booting a controller, a REAL
// [SettingsPage] to drive, and the two readings the picker row needs.
//
// ── WHY THIS SPLIT (2026-08-27) ──────────────────────────────────────────────
// `text_scale_test.dart` reached 1,414 lines against `verify/lint/file-size.mjs`
// TEST_HTML_MAX=1200 when the five chips became a slider (the picker grew from
// one case to five, plus a 320dp row case). Same call as 0.2.52 §5 and
// `settings_custom_terms.dart`: **structural split, not deleted evidence** —
// not one measured paragraph was dropped to get under the cap.
//
// The line drawn is 「the rungs」 (text_scale_test.dart: persistence, the
// factors reaching `MediaQuery.textScaler`, the system-curve multiplication,
// the overflow budgets) versus 「the picker」 (text_scale_picker_test.dart: the
// control the user touches). The ruling that caused the split drew exactly the
// same line, so the two files each answer one question.
//
// 🔴 DIFF DISCIPLINE: every body below was moved **character-for-character**
// out of `text_scale_test.dart`. The ONLY mechanical edit is that the names
// lost their leading underscore so two libraries can share them — both call
// sites re-declare the old private names as one-line shims, so the bodies of
// the cases are untouched and any other difference in this move is a bug.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/text_scale_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'cloud_summary_fakes.dart';
import 'di.dart';
import 'fakes.dart';
import 'legibility.dart';
import 'portable_fakes.dart';
import 'settings_fakes.dart';
import 'update_fakes.dart';

const String kTextScalePrefKey = 'flowmic.pref.textScale';

/// The production key of the picker on the settings page (2026-08-27: one
/// slider, where there used to be five chips).
final Finder textScaleSliderFinder =
    find.byKey(const ValueKey<String>('settings.textScale.slider'));

/// What the row must say for [step] — **derived from the factor**, exactly
/// as the product derives it, never a literal table. See the picker file's
/// header: a second table is the shape the ruling deleted.
String textScalePct(AppTextScale step) => '${step.percent}%';

/// The criterion for 「the user can read the percentage」 on the row.
///
/// 🔴 It is deliberately NOT `expectLegible`. The read-out sits in a `Row`
/// beside an `Expanded` title, so Flutter hands it **unbounded** width —
/// and `support/legibility.dart` refuses that case on purpose ("this text was
/// laid out at infinite width ⇒ it proved nothing about does it fit"). It is
/// right to refuse: a paragraph that can never be squeezed cannot answer the
/// clipping question, and asserting `didExceedMaxLines` on it would be the
/// always-false instrument that file exists to ban.
///
/// The falsifiable reading for THIS structure is geometric instead: it kept
/// the width it needs (the `Expanded` title did not eat it), and it was
/// painted inside the screen rather than off the edge — which is exactly the
/// way a fixed-width child of an over-full `Row` fails.
void expectTextScaleReadOutOnScreen(
  WidgetTester tester,
  Finder f, {
  required String reason,
}) {
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  expect(
    p.size.width,
    greaterThanOrEqualTo(neededWidthOf(p) - 0.5),
    reason: 'the percentage was squeezed to ${p.size.width.toStringAsFixed(1)}px '
        '(needs ${neededWidthOf(p).toStringAsFixed(1)}px): $reason',
  );
  final double screen =
      tester.view.physicalSize.width / tester.view.devicePixelRatio;
  final Rect r = tester.getRect(f);
  expect(r.left, greaterThanOrEqualTo(-0.5),
      reason: 'the percentage was painted off the LEFT edge: $reason');
  expect(r.right, lessThanOrEqualTo(screen + 0.5),
      reason: 'the percentage was painted off the RIGHT edge '
          '(${r.right.toStringAsFixed(1)}px on a ${screen.toStringAsFixed(1)}px screen): $reason');
}

Future<AppSettingsController> bootTextScale(Map<String, Object> initial) async {
  SharedPreferences.setMockInitialValues(initial);
  final AppSettingsController c = AppSettingsController(
    prefs: await SharedPreferences.getInstance(),
  );
  await c.load();
  return c;
}

/// A REAL [SettingsPage] under a REAL [TextScaleScope], with the nine
/// controllers the page demands, all faked. Same shape as `main.dart`: the scope
/// lives in `MaterialApp.builder`, so everything the page pushes is under it.
///
/// 🔴 WHY THIS EXISTS. Before the W5a fix lane, the three production chips
/// `settings.textScale.{large,medium,small}` had ZERO references anywhere under
/// `test/`. The "wiring" test in group ② calls `c.setTextScale(...)`
/// directly with a comment saying that is "what that row on the settings page
/// does" — an assertion about behaviour elsewhere with nothing pinning it
/// (anti-façade ④).
/// Measured consequence: **delete the whole type-size row from
/// `settings_preferences.dart` and the entire suite stays green**, exactly the
/// shape 13 册 §7 F1 ① names (a lost call site leaves no new symbol to grep).
/// `page_guides_test.dart` in that same window taps two real production keys on
/// a real page; this rig makes that possible here.
class TextScaleSettingsRig {
  late final FakeSocketTransport settingsTransport;
  late final SettingsClient settingsClient;
  late final ScenarioCardController scenario;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;
  late final AppSettingsController appSettings;

  /// [c] is owned by the caller (it is the controller under test).
  static Future<TextScaleSettingsRig> create(AppSettingsController c) async {
    final TextScaleSettingsRig r = TextScaleSettingsRig();
    r.appSettings = c;
    r.settingsTransport = FakeSocketTransport();
    r.settingsClient = SettingsClient(
        transport: r.settingsTransport, roomJoins: ValueNotifier<int>(0));
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
    builder: (BuildContext context, Widget? page) =>
        TextScaleScope(appSettings: appSettings, child: page!),
    home: SettingsPage(
      scenario: scenario,
      appSettings: appSettings,
      login: login,
      destination: destination,
      session: session,
      portable: newTestPortableController(),
      prefs: newTestPrefsController(),
      backup: newTestSettingsBackup(),
      inventory: newTestInventory(
        rows: const <TimelineEntry>[],
        images: newTestOutboxBlobs(),
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
    destination.dispose();
    await session.dispose();
    await settingsTransport.close();
  }
}

/// A viewport tall enough that the whole settings `ListView` is laid out, so the
/// preferences card is really built. Same trick and same reason as
/// `about_version_widget_test.dart`'s `tallViewport`.
void tallSettingsViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 4200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}
