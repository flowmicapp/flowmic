// NR-297 — a store build draws the quota-rules guide WITHOUT the link card to
// the web billing page (prices + checkout outside the store).
//
// SPEC-REF:
//   apps/mobile/lib/src/support/store_channel_flag.dart — the flag, its default
//     and why it is its own define.
//   apps/mobile/lib/src/ui/quota_rules_page.dart — the consumer.
//   scripts/nr297-store-billing-link-gate.test.mjs — the byte half: these cases
//     prove what the page DRAWS; only the artifact gate proves the link's code
//     and URL are absent from a store binary.
//
// 🔴 ASSERTIONS LAND ON THE RENDERED TREE (D-15): the link's open control, its
// label and its URL are each looked for on screen, and each 「absent」 case
// carries a positive control — the rules above the card are rendered and
// legible — so 「nothing found」 cannot mean 「the page never drew」.
//
// ⚠️ This file is run TWICE by `make -C apps/mobile gate-test`: once plain
// (direct build) and once with `--dart-define=FLOWMIC_STORE_CHANNEL=1` (store
// build). The last group is what that second run is for: it renders the page
// with the PRODUCTION default and checks it follows the build-time const.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/support/legal_urls.dart' show kBillingPageUrl;
import 'package:flowmic/src/support/store_channel_flag.dart';
import 'package:flowmic/src/ui/quota_rules_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/legibility.dart';

const ValueKey<String> _openKey = ValueKey<String>('quotaRules.billing.open');

/// `null` = leave the production default in place.
Future<Widget> _page({bool? storeChannel}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.en);
  return MaterialApp(
    home: storeChannel == null
        ? QuotaRulesPage(appSettings: appSettings)
        : QuotaRulesPage(appSettings: appSettings, storeChannel: storeChannel),
  );
}

void _narrowPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360 * 3, 900 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// The rules the page owes every reader, store build or not.
void _expectRulesDrawn(WidgetTester tester, AppStrings s) {
  for (final String line in <String>[
    s.quotaRulesLine1,
    s.quotaRulesLine5,
    s.quotaRulesClosing,
  ]) {
    expect(find.text(line), findsOneWidget, reason: line);
    expectLegible(tester, find.text(line), reason: line);
  }
}

void _expectLinkDrawn(WidgetTester tester, AppStrings s) {
  expect(find.byKey(_openKey), findsOneWidget);
  expect(find.text(kBillingPageUrl), findsOneWidget);
  expect(find.text(s.quotaRulesConsoleLink), findsOneWidget);
  expectLegible(tester, find.text(kBillingPageUrl), reason: 'billing URL');
}

void _expectLinkAbsent(AppStrings s) {
  expect(find.byKey(_openKey), findsNothing);
  expect(find.text(s.quotaRulesConsoleLink), findsNothing);
  // Any text carrying the path, not only the exact URL: a reworded card that
  // still showed the address would be the same steering.
  expect(find.textContaining('/console/billing'), findsNothing);
}

void main() {
  const AppStrings s = AppStringsEn();

  group('the seam, both directions in one process', () {
    testWidgets(
      'not a store build: the billing link card is drawn',
      (WidgetTester tester) async {
        _narrowPhone(tester);
        await tester.pumpWidget(await _page(storeChannel: false));
        await tester.pumpAndSettle();
        _expectRulesDrawn(tester, s);
        _expectLinkDrawn(tester, s);
        expect(tester.takeException(), isNull);
      },
      // In the store run the const wins over the seam by design (the seam can
      // only take the link away), so this direction cannot be drawn there; the
      // plain run covers it. A reported skip, not a silent early return.
      skip: kStoreChannelBuild,
    );

    testWidgets(
      'store build: the rules are drawn and the billing link is not',
      (WidgetTester tester) async {
        _narrowPhone(tester);
        await tester.pumpWidget(await _page(storeChannel: true));
        await tester.pumpAndSettle();
        _expectRulesDrawn(tester, s);
        _expectLinkAbsent(s);
        expect(tester.takeException(), isNull);
      },
    );
  });

  group('the production default follows the build-time const', () {
    testWidgets('the default constructor draws exactly what the build says', (
      WidgetTester tester,
    ) async {
      _narrowPhone(tester);
      await tester.pumpWidget(await _page());
      await tester.pumpAndSettle();
      _expectRulesDrawn(tester, s);
      if (kStoreChannelBuild) {
        _expectLinkAbsent(s);
      } else {
        _expectLinkDrawn(tester, s);
      }
      expect(tester.takeException(), isNull);
    });

    test('the documented spelling `=1` reaches the const', () {
      // The store run passes `--dart-define=FLOWMIC_STORE_CHANNEL=1`, the
      // spelling the Makefile uses. `bool.fromEnvironment` alone would read it
      // as false; this pins that the raw form is honoured.
      const String raw = String.fromEnvironment(kStoreChannelDefineKey);
      expect(kStoreChannelBuild, raw == '1' || raw == 'true');
    });
  });
}
