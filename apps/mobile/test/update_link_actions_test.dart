// 0.3.28 — the addresses on the update card became things you can ACT on.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/settings_update_card.dart (the in-place correction
//     at the top of that file: why this took ten days longer than it had to)
//   apps/mobile/lib/src/update/install_source.dart (storeListingUrls)
//   docs/strategy/2026-08-23-0328-feature-design.md §4 card C
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM update_card_widget_test.dart ───────
//
// That file asks 「is the right SENTENCE on screen, in every language, actually
// painted」. This one asks 「when the user taps, what did we DO」. They are
// different questions and they fail for different reasons: a control can render
// perfectly and call nothing, which is this repo's named #1 façade shape and
// precisely what the old card's own header was defending («no url_launcher
// dependency [measured]» — a measurement that had expired ten days earlier).
//
// 🔴 EVERY ASSERTION HERE LANDS ON THE CALL, NOT ON THE WIDGET. A test that
// asserted an 「Open」 label exists would have been green for the entire life of
// the defect this file closes.
//
// ⚠️ What it does NOT prove: that any of these URLs open anything on a real
// handset. `launchUrl` is replaced by a recording fake, deliberately — the
// alternative is a test that needs a device and therefore never runs. The store
// path in particular has NEVER met a real store install (this product is on no
// store), and install_source.dart says so at the function itself.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/settings_update_card.dart';
import 'package:flowmic/src/update/install_source.dart';
import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_manifest.dart' show UpdateArtifact;
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart' show LaunchMode;
import 'package:flutter_test/flutter_test.dart';

import 'support/update_fakes.dart';

const String _sha =
    'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';

/// A kind this build cannot install, so the card shows addresses and no button
/// — the state whose entire value is the address being usable.
UpdateArtifact _zip() => const UpdateArtifact(
  kind: 'portable-zip',
  locale: null,
  filename: 'FlowMic-9.9.9-portable.zip',
  url: 'https://example.invalid/dl/FlowMic-9.9.9-portable.zip',
  sha256: _sha,
  size: 1234,
);

/// Records every launch attempt, and answers whatever the test says.
class _Launcher {
  _Launcher({this.answer = true, this.throwOn});

  final bool answer;
  final String? throwOn;
  final List<String> tried = <String>[];
  final List<LaunchMode> modes = <LaunchMode>[];

  Future<bool> call(Uri url, {required LaunchMode mode}) async {
    tried.add(url.toString());
    modes.add(mode);
    final String? prefix = throwOn;
    if (prefix != null && url.toString().startsWith(prefix)) {
      throw StateError('nothing on this device claims $url');
    }
    return answer;
  }
}

Future<UpdateController> _rig({
  required UpdateCheckResult result,
  bool fromStore = false,
}) async {
  final UpdateController c = newTestUpdateController(
    storeProbe: () async => fromStore,
    checker: (({required String? currentVersion}) async => result),
  );
  await c.load();
  await c.checkNow();
  return c;
}

Widget _host(UpdateController c, _Launcher l, {StoreListingResolver? listings}) =>
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: 360,
            child: SettingsUpdateCard(
              controller: c,
              strings: AppStrings.of(AppLocale.en),
              urlLauncher: l.call,
              storeListings: listings ?? () async => const <String>[],
            ),
          ),
        ),
      ),
    );

void main() {
  final AppStrings s = AppStrings.of(AppLocale.en);
  final UpdateCheckResult available = UpdateCheckResult(
    UpdateCheckOutcome.updateAvailable,
    latestVersion: '9.9.9',
    downloadUrl: _zip().url,
    notesUrl: 'https://example.invalid/notes/9.9.9',
    comparedAt: DateTime.utc(2026, 8, 24, 10),
  );

  group('an address is openable, and the tap is proven by the call', () {
    testWidgets('tapping Open hands THIS url to the launcher, externally',
        (WidgetTester tester) async {
      final UpdateController c = await _rig(result: available);
      addTearDown(c.dispose);
      final _Launcher l = _Launcher();
      await tester.pumpWidget(_host(c, l));

      await tester.tap(
        find.byKey(ValueKey<String>('update.open.${s.updateDownloadUrlLabel}')),
      );
      await tester.pumpAndSettle();

      expect(l.tried, <String>[_zip().url],
          reason: 'the download address was not the thing handed to the launcher');
      expect(l.modes.single, LaunchMode.externalApplication,
          reason: 'an in-app webview would trap the user inside FlowMic on a download link');
    });

    testWidgets('🔴 a launcher that answers false says so — a dead tap is forbidden',
        (WidgetTester tester) async {
      final UpdateController c = await _rig(result: available);
      addTearDown(c.dispose);
      final _Launcher l = _Launcher(answer: false);
      await tester.pumpWidget(_host(c, l));

      final String label = s.updateDownloadUrlLabel;
      expect(find.byKey(ValueKey<String>('update.openFailed.$label')), findsNothing,
          reason: 'nothing has failed yet — the sentence must not be pre-painted');
      await tester.tap(find.byKey(ValueKey<String>('update.open.$label')));
      await tester.pumpAndSettle();
      expect(find.byKey(ValueKey<String>('update.openFailed.$label')), findsOneWidget);
      expect(find.text(s.updateOpenFailed), findsOneWidget);
    });

    testWidgets('a launcher that THROWS gets the same sentence — same fact to the user',
        (WidgetTester tester) async {
      final UpdateController c = await _rig(result: available);
      addTearDown(c.dispose);
      final _Launcher l = _Launcher(throwOn: 'https://');
      await tester.pumpWidget(_host(c, l));

      final String label = s.updateDownloadUrlLabel;
      await tester.tap(find.byKey(ValueKey<String>('update.open.$label')));
      await tester.pumpAndSettle();
      expect(find.byKey(ValueKey<String>('update.openFailed.$label')), findsOneWidget);
    });

    testWidgets('🔴 the copy control did NOT go away when Open arrived',
        (WidgetTester tester) async {
      // The common reason to want a download URL is to finish the job on the
      // other machine. Hiding copy behind a failure would serve that badly on
      // the path that works.
      final UpdateController c = await _rig(result: available);
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, _Launcher()));
      expect(
        find.byKey(ValueKey<String>('update.copy.${s.updateDownloadUrlLabel}')),
        findsOneWidget,
      );
    });
  });

  group('the store handoff (owner 2026-08-23: if a store can update it, go there)', () {
    final UpdateCheckResult upToDate = UpdateCheckResult(
      UpdateCheckOutcome.upToDate,
      latestVersion: '0.0.1',
      comparedAt: DateTime.utc(2026, 8, 24, 10),
    );
    const List<String> both = <String>[
      'market://details?id=x',
      'https://play.example/x',
    ];

    testWidgets('🔴 market:// is tried FIRST and, when it takes, nothing else is',
        (WidgetTester tester) async {
      final UpdateController c = await _rig(result: upToDate, fromStore: true);
      addTearDown(c.dispose);
      final _Launcher l = _Launcher();
      await tester.pumpWidget(_host(c, l, listings: () async => both));

      await tester.tap(find.byKey(const ValueKey<String>('update.openStore')));
      await tester.pumpAndSettle();
      expect(l.tried, <String>['market://details?id=x'],
          reason: 'the direct handoff won, so the browser form must not also fire');
    });

    testWidgets('🔴 a device with no Play app falls through to https — the whole reason there are two',
        (WidgetTester tester) async {
      final UpdateController c = await _rig(result: upToDate, fromStore: true);
      addTearDown(c.dispose);
      final _Launcher l = _Launcher(throwOn: 'market://');
      await tester.pumpWidget(_host(c, l, listings: () async => both));

      await tester.tap(find.byKey(const ValueKey<String>('update.openStore')));
      await tester.pumpAndSettle();
      expect(l.tried, both);
      expect(find.byKey(const ValueKey<String>('update.openFailed.store')), findsNothing,
          reason: 'the second candidate took it — that is a success, not a failure');
    });

    testWidgets('every candidate refusing says so out loud', (WidgetTester tester) async {
      final UpdateController c = await _rig(result: upToDate, fromStore: true);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        _host(c, _Launcher(answer: false), listings: () async => both),
      );

      await tester.tap(find.byKey(const ValueKey<String>('update.openStore')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey<String>('update.openFailed.store')), findsOneWidget);
    });

    testWidgets('🔴 no package name ⇒ the sentence still stands, and the tap is not a silent no-op',
        (WidgetTester tester) async {
      final UpdateController c = await _rig(result: upToDate, fromStore: true);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        _host(c, _Launcher(), listings: () async => const <String>[]),
      );

      expect(find.text(s.updateFromStoreNote), findsOneWidget,
          reason: 'the card must read exactly as it did before 0.3.28');
      await tester.tap(find.byKey(const ValueKey<String>('update.openStore')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey<String>('update.openFailed.store')), findsOneWidget);
    });
  });

  group('storeListingUrls — the candidate list itself', () {
    test('two candidates, market first, both carrying the real package id', () async {
      final List<String> urls =
          await storeListingUrls(probe: () async => 'app.flowmic.android');
      expect(urls, <String>[
        'market://details?id=app.flowmic.android',
        'https://play.google.com/store/apps/details?id=app.flowmic.android',
      ]);
    });

    test('🔴 an unknown package name yields NOTHING, never a half-built url', () async {
      expect(await storeListingUrls(probe: () async => null), isEmpty);
      expect(await storeListingUrls(probe: () async => '   '), isEmpty);
      expect(
        await storeListingUrls(probe: () async => throw StateError('no plugin')),
        isEmpty,
        reason: 'a throwing probe is our own plumbing failing; it must not '
            'become a url pointing at nothing',
      );
    });
  });
}
