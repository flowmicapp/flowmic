// Card WB-5a — the quota-rules guide: the card under the connections list and
// the page behind it.
//
// SPEC-REF:
//   docs/decisions/2026-09-12-owner-web-client-batch-image-upload-qr-only-and-hints.md
//     item 5 — owner removed the transcription screen's standing 「the computer
//     you are connected to pays」 line and asked for this guide instead.
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §0.2 — the rule the five
//     lines state, including the demo page's 120-second per-browser cap.
//   apps/mobile/lib/src/settings/strings/metering_strings.dart — the copy and
//     the reasoning for each line.
//   far_end_payer_faces_test.dart group ③ — the other half of this change: the
//     chat page must now draw NOTHING on a payer frame.
//
// ── 🔴 WHY THE CASES MOUNT THE REAL SCREENS ─────────────────────────────────
//
// Anti-façade ⑥, paid for by CR-7/CR-8: 「a long recording is one card」 was
// asserted on the MODEL by one file and on a hand-built `ArticlePage` by
// another, both honestly green, while the screen where recording actually
// happens had neither — the two ends of a wire were tested and nothing walked
// the middle. So the first case here mounts `ConnectionsPage` itself over the
// real controllers, and the second reaches the detail page by TAPPING the card,
// not by constructing `QuotaRulesPage` directly. A row that exists but is not
// reachable is the defect these cases exist to catch.
//
// ── 🔴 WHY THE COPY ASSERTIONS LAND ON THE RENDERED PARAGRAPH ───────────────
//
// 0.2.53: a suite can be green while the screen shows three letters, because
// `Text.data` is what we built and the user reads what survives layout. Every
// legibility claim below goes through `expectLegible`, whose header explains
// why `didExceedMaxLines` alone would have been an instrument that cannot fail.
//
// ⚠️ THE FONT IS AHEM — every glyph is a full em square, so a 360 dp line holds
// far fewer characters than on a device. That direction is conservative for
// 「will it be clipped」 and does NOT run backwards: nothing here may be read as
// 「it fits on a real phone」.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/support/legal_urls.dart' show kBillingPageUrl;
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/quota_rules_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';

Future<HealthReading> _probeUnreachable(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

/// The real connections page over the real controllers. Only the socket, the
/// recorder and the two network probes are doubles — production's probes are
/// real `HttpClient`s and a widget case that reached the network would hang on
/// every `pumpAndSettle` in this file.
Future<Widget> _connectionsPage(AppLocale locale) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(locale);
  final PttSession session = PttSession(
    transport: FakeSocketTransport(),
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: InMemoryTokenStorage(),
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: _probeUnreachable,
    presenceReader: _presenceUnknown,
  );
  return MaterialApp(
    home: ConnectionsPage(
      connections: connections,
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
      settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
      historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
      updateListenable: ValueNotifier<bool>(false),
      hasUpdate: () => false,
    ),
  );
}

/// A 360 dp Android phone, the narrowest common width. `flutter_test`'s default
/// 800x600 surface is a tablet and would hide the layout question entirely.
void _narrowPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360 * 3, 900 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// Every sentence the detail page owes a reader, in the order it lays them out.
List<String> _pageLines(AppStrings s) => <String>[
  s.quotaRulesSub,
  s.quotaRulesLine1,
  s.quotaRulesLine2,
  s.quotaRulesLine3,
  s.quotaRulesLine4,
  s.quotaRulesLine5,
  s.quotaRulesClosing,
  s.quotaRulesConsoleLink,
];

void main() {
  group('the card under the connections list', () {
    testWidgets('renders its title and its one-line answer', (WidgetTester tester) async {
      _narrowPhone(tester);
      await tester.pumpWidget(await _connectionsPage(AppLocale.zh));
      await tester.pumpAndSettle();

      const AppStrings s = AppStringsZh();
      // 🔴 The page resolves its OWN catalogue from the app settings, so the
      // assertion is made against that catalogue. Asserting English here would
      // fail for a reason that has nothing to do with this card — and worse, it
      // would PASS on a build that stopped localising the screen.
      expect(find.text(s.quotaRulesTitle), findsOneWidget);
      expect(find.text(s.quotaRulesSub), findsOneWidget);
      expectLegible(tester, find.text(s.quotaRulesTitle), reason: 'card title');
      expectLegible(tester, find.text(s.quotaRulesSub), reason: 'card subtitle');
      expect(tester.takeException(), isNull);
    });

    testWidgets('it is reachable: tapping it opens the guide', (WidgetTester tester) async {
      // The middle of the wire. Without this the card could render perfectly
      // and open nothing, and every other case in this file would still pass —
      // the second one would construct the page itself and never notice.
      _narrowPhone(tester);
      await tester.pumpWidget(await _connectionsPage(AppLocale.zh));
      await tester.pumpAndSettle();
      expect(find.byType(QuotaRulesPage), findsNothing,
          reason: 'positive control: the page is not already on screen, so the '
              'assertion below is about the tap');

      await tester.tap(find.byKey(const ValueKey<String>('connections.quotaRules')));
      await tester.pumpAndSettle();
      expect(find.byType(QuotaRulesPage), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('the guide itself', () {
    for (final AppLocale locale in <AppLocale>[AppLocale.zh, AppLocale.en]) {
      testWidgets('every line is on screen and readable in $locale',
          (WidgetTester tester) async {
        _narrowPhone(tester);
        await tester.pumpWidget(await _connectionsPage(locale));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey<String>('connections.quotaRules')));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(locale);
        for (final String line in _pageLines(s)) {
          // `find.text` is an exact match on the rendered span, so a line that
          // was truncated into the layout would not be found at all; the
          // legibility instrument then answers the other half — whether what IS
          // there was squeezed onto a line too narrow to hold it.
          expect(find.text(line), findsOneWidget, reason: line);
          expectLegible(tester, find.text(line), reason: line);
        }
        // ⚠️ Vertical clipping is not `expectLegible`'s job — an ancestor with a
        // fixed height throws instead, and this is where that shows up.
        expect(tester.takeException(), isNull);

        // The title is on the app bar, not in the body, so it is asserted
        // separately rather than being quietly absent from the loop above.
        expect(find.text(s.quotaRulesTitle), findsOneWidget);
      });
    }

    testWidgets('it names one number and it is the demo cap', (WidgetTester tester) async {
      // 🔴 A FAR END'S REMAINDER MAY NOT APPEAR HERE. Every `billing:budget`
      // frame carries one and it is a stranger's commercial fact; the only
      // figure this page is allowed is the one the RULE itself contains (22 册
      // §0.2, 120 seconds per browser). Asserted per language on the catalogue,
      // because a translation is where a helpful extra number would get added.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String line in _pageLines(s)) {
          if (line == s.quotaRulesLine3) {
            expect(line, contains('120'), reason: '$locale line3');
            continue;
          }
          expect(line, isNot(matches(RegExp(r'[0-9]'))), reason: '$locale: $line');
        }
      }
    });

    testWidgets('the link row points at the reader OWN plan', (WidgetTester tester) async {
      _narrowPhone(tester);
      await tester.pumpWidget(await _connectionsPage(AppLocale.en));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('connections.quotaRules')));
      await tester.pumpAndSettle();

      // The URL is rendered, not only wired: a link whose address the user
      // cannot read is one they cannot type in when the launcher refuses, and
      // refusing is the case `discOpenFailed` exists for.
      expect(find.text(kBillingPageUrl), findsOneWidget);
      expect(kBillingPageUrl, endsWith('/console/billing'));
      expect(find.byKey(const ValueKey<String>('quotaRules.billing.open')),
          findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
