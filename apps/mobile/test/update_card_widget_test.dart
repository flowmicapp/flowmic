// UP-2 — **render-level** acceptance for the update section.
//
// 🔴 The criterion lands on **what was painted**, not on `Text.data`.
// The 0.2.53 ledger: `cloud_image_error_copy_test.dart` itself wrote "what is
// asserted is the Text's own data, so even if this row would be clipped by
// Flexible+ellipsis it still matches" — 1259 cases all green, and the screen
// showed three letters (`INJ…`). So this file puts every user-visible sentence
// through the gauge in `test/support/legibility.dart`.
//
// ⚠️ The ruler: `flutter_test` uses the Ahem placeholder font; every glyph is a
// full-em square, much wider than a real font. "Not clipped under Ahem ⇒ will
// not be clipped on a real device" holds; **the converse does not**. This file
// only answers "will it be clipped".

import 'dart:io';

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/settings_update_card.dart';
import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flowmic/src/update/update_download.dart';
import 'package:flowmic/src/update/update_installer.dart';
import 'package:flowmic/src/update/update_manifest.dart' show UpdateArtifact;
import 'package:flowmic/src/update/update_prefs.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart';
import 'support/locale_terms.dart';
import 'support/update_fakes.dart';

const String _sha = 'abc1230000000000000000000000000000000000000000000000000000000def';

UpdateArtifact _apk() => const UpdateArtifact(
  kind: 'apk',
  locale: null,
  filename: 'FlowMic-9.9.9-release.apk',
  url: 'http://100.64.7.68/dl/flowmic/release/FlowMic-9.9.9-release.apk',
  sha256: _sha,
  size: 45678901,
);

/// A controller that has already been load()ed, with the conclusion specified by the test.
Future<UpdateController> _rig({
  UpdateCheckResult? result,
  bool autoCheck = true,
  DateTime? lastSuccess,
  bool selfUpdateEnabled = true,
  bool notifyOnlyEnabled = false,
  UpdateDownloader? downloader,
  UpdateInstallRunner? installer,
}) async {
  final UpdateController c = newTestUpdateController(
    prefs: InMemoryUpdatePrefs(autoCheck: autoCheck, lastSuccess: lastSuccess),
    selfUpdateEnabled: selfUpdateEnabled,
    notifyOnlyEnabled: notifyOnlyEnabled,
    // 🔴 Default **does not** supply a downloader: omitting it is the production
    // implementation, and the production implementation will hit path_provider's
    // platform channel. So tests that "tap the button" must say what they
    // expect, and tests that "do not tap the button" will never get there. This
    // is not an oversight; it makes a "quietly tapped once" go red.
    downloader: downloader,
    installer: installer,
    checker: result == null
        ? null
        : (({required String? currentVersion}) async => result),
  );
  await c.load();
  if (result != null) await c.checkNow();
  return c;
}

Widget _host(UpdateController c, AppLocale locale) => MaterialApp(
  home: Scaffold(
    // 360dp is the narrow-screen width this repo uses (the ledger computed in the chat_header round).
    body: Center(
      child: SizedBox(
        width: 360,
        child: SettingsUpdateCard(controller: c, strings: AppStrings.of(locale)),
      ),
    ),
  ),
);

/// Every piece of text in this tree is readable (render-level), and there is no overflow exception.
void expectEverythingLegible(WidgetTester tester) {
  for (final Element e in find.byType(Text).evaluate()) {
    expectLegible(tester, find.byWidget(e.widget), reason: (e.widget as Text).data);
  }
  expect(tester.takeException(), isNull, reason: 'something overflowed');
}

void main() {
  group('🔴 unknown ≠ up-to-date — the shape on screen', () {
    // This group is this card's red line. Traverse outcomes **exhaustively**,
    // not a few spot-checks: if a newly added outcome is mis-wired onto the
    // "already latest" branch, this must go red on the spot.
    for (final UpdateCheckOutcome outcome in UpdateCheckOutcome.values) {
      if (outcome == UpdateCheckOutcome.upToDate) continue;
      testWidgets('$outcome must not show 「已是最新」 on the painted screen', (WidgetTester tester) async {
        final UpdateController c = await _rig(
          result: UpdateCheckResult(
            outcome,
            latestVersion: outcome == UpdateCheckOutcome.updateAvailable ? '9.9.9' : null,
            installable: outcome == UpdateCheckOutcome.updateAvailable ? _apk() : null,
            downloadUrl: outcome == UpdateCheckOutcome.updateAvailable ? _apk().url : null,
            comparedAt: outcome == UpdateCheckOutcome.updateAvailable
                ? DateTime.utc(2026, 8, 8, 9, 12)
                : null,
          ),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, AppLocale.zh));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(AppLocale.zh);
        // One 「已是最新」 per locale, none of them may appear.
        for (final AppLocale l in AppLocale.values) {
          for (final String v in <String>['9.9.9', '0.2.59', '']) {
            expect(
              find.text(AppStrings.of(l).updateUpToDate(v)),
              findsNothing,
              reason: '$outcome actually said 「已是最新」',
            );
          }
        }
        // And it must say **its own sentence** (not a generic "update failed").
        if (outcome != UpdateCheckOutcome.updateAvailable) {
          expect(find.text(_sentenceFor(s, outcome)), findsOneWidget);
        }
        expectEverythingLegible(tester);
      });
    }

    testWidgets(
      '🔴 「已是最新」 and 「上次成功检查于 …」 must share the same frame — that line is its only warrant',
      (WidgetTester tester) async {
        final DateTime at = DateTime.utc(2026, 8, 8, 9, 12);
        final UpdateController c = await _rig(
          result: UpdateCheckResult(
            UpdateCheckOutcome.upToDate,
            latestVersion: '0.2.59',
            comparedAt: at,
          ),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, AppLocale.zh));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(AppLocale.zh);
        expect(find.text(s.updateUpToDate('0.2.59')), findsOneWidget);
        // The warrant is there, and it is not "never successfully checked".
        expect(
          find.text(s.updateLastSuccessAt(formatCheckedAt(at))),
          findsOneWidget,
          reason: '「已是最新」 is on screen and the warrant is not ⇒ a client that never checked successfully would look the same',
        );
        expect(find.text(s.updateNeverChecked), findsNothing);
        expectEverythingLegible(tester);
      },
    );

    testWidgets('never successfully checked ⇒ say so out loud, no blank', (WidgetTester tester) async {
      final UpdateController c = await _rig();
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, AppLocale.zh));
      await tester.pumpAndSettle();
      expect(find.text(AppStrings.of(AppLocale.zh).updateNeverChecked), findsOneWidget);
      expectEverythingLegible(tester);
    });

    testWidgets(
      '🔴 auto-check off ⇒ say 「自动检查已关闭」 + the manual button is still there, never say 「已是最新」',
      (WidgetTester tester) async {
        final UpdateController c = await _rig(autoCheck: false);
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, AppLocale.zh));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(AppLocale.zh);
        expect(find.text(s.updateAutoCheckOffNote), findsOneWidget);
        expect(find.byKey(const ValueKey<String>('update.checkNow')), findsOneWidget);
        for (final String v in <String>['0.2.59', '']) {
          expect(find.text(s.updateUpToDate(v)), findsNothing);
        }
        expectEverythingLegible(tester);
      },
    );
  });

  group('update available', () {
    testWidgets('version + download URL on screen, and the URL is a selectable real URL', (WidgetTester tester) async {
      final UpdateController c = await _rig(
        result: UpdateCheckResult(
          UpdateCheckOutcome.updateAvailable,
          latestVersion: '9.9.9',
          installable: _apk(),
          downloadUrl: _apk().url,
          notesUrl: 'http://100.64.7.68/dl/flowmic/release/NOTES.md',
          comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
        ),
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, AppLocale.zh));
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(AppLocale.zh);
      expect(find.text(s.updateAvailableTitle('9.9.9')), findsOneWidget);
      // The path the user can take right now: the address is visible.
      expect(find.text(_apk().url), findsOneWidget);
      expect(find.text(s.updateDownloadUrlLabel), findsOneWidget);
      expectEverythingLegible(tester);
    });

    testWidgets(
      '🔴 only an unrecognized kind ⇒ still 「有新版本」 + URL + one explanatory sentence, '
      'not an error, not 「已是最新」, and not a state that cannot appear',
      (WidgetTester tester) async {
        final UpdateController c = await _rig(
          result: const UpdateCheckResult(
            UpdateCheckOutcome.updateAvailable,
            latestVersion: '9.9.9',
            installable: null, // portable-zip / dmg — we will not install
            downloadUrl: 'http://100.64.7.68/dl/flowmic/release/FlowMic-portable.zip',
            comparedAt: null,
          ),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, AppLocale.zh));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(AppLocale.zh);
        expect(find.text(s.updateAvailableTitle('9.9.9')), findsOneWidget);
        expect(find.text(s.updateKindUnknownNote), findsOneWidget);
        expect(
          find.text('http://100.64.7.68/dl/flowmic/release/FlowMic-portable.zip'),
          findsOneWidget,
          reason: 'even if it cannot be installed, a walkable path must still be given',
        );
        expectEverythingLegible(tester);
      },
    );

    // ── UP-2b, 2026-08-08: this assertion flipped the way it itself wrote it would ──
    //
    // It used to be called '🔴 this round has no 「下载并安装」 button — a control
    // that does nothing is worse than none', asserting `ElevatedButton
    // findsNothing` / `FilledButton findsNothing`, and the comment previewed
    // "when slice 2 lands it will go red, and that is exactly what it should
    // do (change this comment together with it then)". **slice 2 is this
    // round**, so both change together.
    //
    // 🔴 **After the flip it must still be a gate, not just "the button is
    // there".** The original blocked "a control that does nothing", so the new
    // version does not assert presence, it asserts **tapping it actually does
    // something** — otherwise an `onPressed: () {}` would also make it green,
    // and that is exactly what the original was blocking.
    testWidgets('🔴 the 「下载并安装」 button is there, and tapping it really walks that path (not an empty control)', (
      WidgetTester tester,
    ) async {
      int downloads = 0;
      final UpdateController c = await _rig(
        result: UpdateCheckResult(
          UpdateCheckOutcome.updateAvailable,
          latestVersion: '9.9.9',
          installable: _apk(),
          downloadUrl: _apk().url,
          comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
        ),
        downloader: (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) async {
          downloads++;
          // The criterion includes the artifact: a wiring that "taps and downloads something else" must go red here.
          expect(a.sha256, _sha);
          return const UpdateDownloadResult(
            UpdateDownloadOutcome.hashMismatch,
            detail: 'wired-check',
          );
        },
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, AppLocale.zh));
      await tester.pumpAndSettle();

      expect(find.byType(FilledButton), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('update.install')), findsOneWidget);
      expect(find.text(AppStrings.of(AppLocale.zh).updateDownloadAndInstall),
          findsOneWidget);
      expect(downloads, 0, reason: 'must not download by itself before a tap');

      await tester.tap(find.byKey(const ValueKey<String>('update.install')));
      await tester.pumpAndSettle();

      expect(downloads, 1, reason: 'the button is wired to something else, or not wired at all');
      // And the conclusion actually landed on screen — walking the path and saying nothing is as bad as not walking it.
      expect(
        find.text(AppStrings.of(AppLocale.zh).updateDownloadHashMismatch),
        findsOneWidget,
      );
      expectEverythingLegible(tester);
    });

    testWidgets('🔴 the version that cannot be installed (not apk) ⇒ no button, only the URL', (
      WidgetTester tester,
    ) async {
      // The original rule was not overturned by a single word: giving a button when it cannot be installed is giving a control that can do nothing.
      final UpdateController c = await _rig(
        result: const UpdateCheckResult(
          UpdateCheckOutcome.updateAvailable,
          latestVersion: '9.9.9',
          installable: null,
          downloadUrl: 'http://100.64.7.68/dl/flowmic/release/FlowMic-portable.zip',
        ),
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, AppLocale.zh));
      await tester.pumpAndSettle();
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byKey(const ValueKey<String>('update.install')), findsNothing);
      expect(find.byType(ElevatedButton), findsNothing);
    });

    testWidgets(
      '🔴 the store channel (iOS notify-only): its own sentence, the store page, and no button at all',
      (WidgetTester tester) async {
        final UpdateController c = await _rig(
          selfUpdateEnabled: false,
          notifyOnlyEnabled: true,
          result: UpdateCheckResult(
            UpdateCheckOutcome.updateAvailable,
            latestVersion: '9.9.9',
            storeChannel: true,
            storeUrl: 'https://testflight.apple.com/join/example',
            notesUrl: 'https://github.com/flowmicapp/flowmic/releases/tag/v9.9.9',
            comparedAt: DateTime.utc(2026, 8, 20, 9, 0),
          ),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, AppLocale.zh));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(AppLocale.zh);
        expect(find.text(s.updateAvailableTitle('9.9.9')), findsOneWidget);
        // The store sentence, NOT the 「download it from the address below」 one —
        // that copy would point at a download address this channel never has.
        expect(find.text(s.updateStoreChannelNote), findsOneWidget);
        expect(find.text(s.updateKindUnknownNote), findsNothing);
        // The page the user can walk to, visible and labelled.
        expect(find.text(s.updateStoreUrlLabel), findsOneWidget);
        expect(find.text('https://testflight.apple.com/join/example'), findsOneWidget);
        // And structurally no install control, whatever the wire claims.
        expect(find.byKey(const ValueKey<String>('update.install')), findsNothing);
        expect(find.byType(FilledButton), findsNothing);
        expectEverythingLegible(tester);
      },
    );

    testWidgets(
      'a store entry with no link yet still says the store sentence — never the download copy with no address',
      (WidgetTester tester) async {
        final UpdateController c = await _rig(
          selfUpdateEnabled: false,
          notifyOnlyEnabled: true,
          result: const UpdateCheckResult(
            UpdateCheckOutcome.updateAvailable,
            latestVersion: '9.9.9',
            storeChannel: true,
            storeUrl: null,
          ),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, AppLocale.zh));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(AppLocale.zh);
        expect(find.text(s.updateStoreChannelNote), findsOneWidget);
        expect(find.text(s.updateKindUnknownNote), findsNothing);
        expect(find.text(s.updateStoreUrlLabel), findsNothing);
        expectEverythingLegible(tester);
      },
    );

    testWidgets('🔴 install-segment copy may appear only after the download segment has passed', (WidgetTester tester) async {
      // "Hash mismatch" and "you have not granted install permission" are opposite sentences. Talking about the install segment before download has passed is answering the user with something that never happened.
      final UpdateController c = await _rig(
        result: UpdateCheckResult(
          UpdateCheckOutcome.updateAvailable,
          latestVersion: '9.9.9',
          installable: _apk(),
          downloadUrl: _apk().url,
          comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
        ),
        downloader: (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) async =>
            const UpdateDownloadResult(UpdateDownloadOutcome.sizeMismatch),
        installer: (String _) async {
          fail('download segment did not pass; the installer must not be called');
        },
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, AppLocale.zh));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('update.install')));
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(AppLocale.zh);
      expect(find.text(s.updateDownloadSizeMismatch), findsOneWidget);
      for (final String installSegment in <String>[
        s.updateHandedToInstaller,
        s.updateInstallPermissionRequired,
        s.updateInstallRefused,
        s.updateInstallUnsupported,
      ]) {
        expect(find.text(installSegment), findsNothing);
      }
      expectEverythingLegible(tester);
    });

    testWidgets('the success screen: says 「已交给系统安装器」, readable in all four locales', (
      WidgetTester tester,
    ) async {
      for (final AppLocale locale in AppLocale.values) {
        final UpdateController c = await _rig(
          result: UpdateCheckResult(
            UpdateCheckOutcome.updateAvailable,
            latestVersion: '9.9.9',
            installable: _apk(),
            downloadUrl: _apk().url,
            comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
          ),
          downloader: (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) async =>
              UpdateDownloadResult(
                UpdateDownloadOutcome.verified,
                file: File('${Directory.systemTemp.path}/flowmic-up2b-fake.apk'),
              ),
          installer: (String _) async =>
              const UpdateInstallResult(UpdateInstallOutcome.permissionRequired),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, locale));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey<String>('update.install')));
        await tester.pumpAndSettle();

        expect(
          find.text(AppStrings.of(locale).updateInstallPermissionRequired),
          findsOneWidget,
          reason: '$locale: the only failure on this path the user can fix themselves must be speakable',
        );
        expectEverythingLegible(tester);
      }
    });
  });

  group('when the build-time flag is off', () {
    testWidgets('🔴 that section is still there, just swapped for a human sentence — an absent capability must be visible', (
      WidgetTester tester,
    ) async {
      final UpdateController c = await _rig(selfUpdateEnabled: false);
      addTearDown(c.dispose);
      await tester.pumpWidget(_host(c, AppLocale.zh));
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(AppLocale.zh);
      expect(find.text(s.updateNotBundledTitle), findsOneWidget);
      expect(find.text(s.updateNotBundledNote), findsOneWidget);
      // No switch, no check button — they can do nothing in this build.
      expect(find.byKey(const ValueKey<String>('update.checkNow')), findsNothing);
      expect(find.byType(Switch), findsNothing);
      expectEverythingLegible(tester);
    });
  });

  group('🔴 four locales — every sentence is actually painted on screen, not merely present in the table', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: the update-available screen', (WidgetTester tester) async {
        final UpdateController c = await _rig(
          result: UpdateCheckResult(
            UpdateCheckOutcome.updateAvailable,
            latestVersion: '9.9.9',
            installable: null,
            downloadUrl: _apk().url,
            comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
          ),
        );
        addTearDown(c.dispose);
        await tester.pumpWidget(_host(c, locale));
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings.of(locale);
        expect(find.text(s.updateAvailableTitle('9.9.9')), findsOneWidget);
        expect(find.text(s.updateKindUnknownNote), findsOneWidget);
        expect(find.text(s.updateAutoCheckLabel), findsOneWidget);
        expectEverythingLegible(tester);
      });
    }

    test('each of the four locales is its own sentence, not the same sentence copied four times', () {
      // Asserting only "non-empty" would also be green if all four were English.
      final List<String Function(AppStrings)> keys = <String Function(AppStrings)>[
        (AppStrings s) => s.secUpdate,
        (AppStrings s) => s.updateChecking,
        (AppStrings s) => s.updateKindUnknownNote,
        (AppStrings s) => s.updateOwnVersionUnknown,
        (AppStrings s) => s.updateIncompleteInfo,
        (AppStrings s) => s.updateNoManifestHere,
        (AppStrings s) => s.updateUnavailable,
        (AppStrings s) => s.updateUnreachable,
        (AppStrings s) => s.updateMalformed,
        (AppStrings s) => s.updateNeverChecked,
        (AppStrings s) => s.updateAutoCheckLabel,
        (AppStrings s) => s.updateAutoCheckOffNote,
        (AppStrings s) => s.updateCheckNow,
        (AppStrings s) => s.updateDownloadUrlLabel,
        (AppStrings s) => s.updateNotesUrlLabel,
        (AppStrings s) => s.updateCopyLink,
        (AppStrings s) => s.updateLinkCopied,
        (AppStrings s) => s.updateNotBundledTitle,
        (AppStrings s) => s.updateNotBundledNote,
      ];
      // 🔴 Nine-locale expansion (2026-08-14): "no locale may be identical to
      // the previous one" is no longer true under nine locales. measured
      // (678 keys × 9 locales full sweep) zh and zhTw have 43 byte-identical
      // entries — Simplified/Traditional same-shape; the one this family hits
      // is `updateCheckNow`＝「更新」, the two glyph writings are simply the same.
      // Criterion switched to named: allowed overlaps must be written here;
      // any **unnamed** overlap (e.g. fr copying es) still goes red on the
      // spot, and the failure names which locales copied which sentence.
      // See the comment on `expectPerLocaleDistinct` in `support/locale_terms.dart`.
      for (final String Function(AppStrings) key in keys) {
        expectPerLocaleDistinct(
          key,
          what: 'update card copy',
          mayShare: const <Set<AppLocale>>[
            <AppLocale>{AppLocale.zh, AppLocale.zhTw},
            // 🔴 This one was **caught by the new criterion itself**, not
            // written in advance by me:
            // `secUpdate` is 'Updates' on both en and de. German borrowed the
            // word as-is (in German UI 'Updates' is the common wording, not a
            // missed translation). The old `hasLength(4)` was blind to it — it
            // only counted, and could not say which two locales collided.
            // After naming it, **other** overlaps (e.g. fr copying es) still
            // go red on the spot.
            <AppLocale>{AppLocale.en, AppLocale.de},
          ],
        );
      }
    });

    test('🔴 every outcome cell has its own sentence; no two cells share one', () {
      // The type-level shape of "each failure speaks for itself": merge two sentences and this goes red on the spot.
      final AppStrings s = AppStrings.of(AppLocale.zh);
      final Set<String> seen = <String>{};
      for (final UpdateCheckOutcome o in UpdateCheckOutcome.values) {
        if (o == UpdateCheckOutcome.updateAvailable || o == UpdateCheckOutcome.upToDate) {
          continue;
        }
        expect(seen.add(_sentenceFor(s, o)), isTrue, reason: '$o shared the same sentence with another cell');
      }
    });
  });
}

/// The sentence that belongs to each outcome cell. **This table is deliberately
/// written a second time in the test**, not exported from the production table
/// and reused: if it were reused, whoever wired two cells onto the same
/// sentence would move both sides together and the test would stay green — an
/// assertion that travels with the thing under test is not a gate.
String _sentenceFor(AppStrings s, UpdateCheckOutcome o) => switch (o) {
  UpdateCheckOutcome.ownVersionUnknown => s.updateOwnVersionUnknown,
  UpdateCheckOutcome.incompleteInfo => s.updateIncompleteInfo,
  UpdateCheckOutcome.noManifestHere => s.updateNoManifestHere,
  UpdateCheckOutcome.unavailable => s.updateUnavailable,
  UpdateCheckOutcome.unreachable => s.updateUnreachable,
  UpdateCheckOutcome.malformed => s.updateMalformed,
  UpdateCheckOutcome.updateAvailable => s.updateAvailableTitle('9.9.9'),
  UpdateCheckOutcome.upToDate => s.updateUpToDate('0.2.59'),
};
