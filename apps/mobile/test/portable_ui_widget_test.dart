// 16 册 §9 acceptance — the surfaces.
//
// §7's row: 「the sentence before export **really renders** (widget/component test, positive probe non-empty)」. A warning
// that lives only in the catalogue is the same as no warning, which is precisely
// the façade shape this repo checks for.
//
// Also here: the settings entry points exist and are wired, the size number
// beside the checkbox is the INVENTORY's number, and none of the four languages
// smuggles in 「请妥善保管」.

import 'dart:typed_data';

import 'package:flowmic/src/portable/export_sheet.dart';
import 'package:flowmic/src/portable/portable_controller.dart';
import 'package:flowmic/src/portable/portable_export.dart';
import 'package:flowmic/src/portable/portable_import.dart';
import 'package:flowmic/src/portable/fpr_record.dart';
import 'package:flowmic/src/session/image_payload.dart' show formatBytes;
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';
import 'support/portable_rows.dart';
import 'support/locale_terms.dart';

const List<AppLocale> _locales = AppLocale.values;

Widget _host(PortableController c, AppStrings s) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (BuildContext context) => TextButton(
        onPressed: () => showExportSheet(context, controller: c, strings: s),
        child: const Text('open'),
      ),
    ),
  ),
);

void main() {
  group('§7 plaintext warning', () {
    testWidgets('🔴 the sentence is ON SCREEN before anything is written',
        (WidgetTester tester) async {
      const AppStrings s = AppStringsZh();
      final PortableController c = newTestPortableController(rows: testRows(3));
      await tester.pumpWidget(_host(c, s));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // Positive probe: the exact catalogue string is rendered.
      expect(find.text(s.exportPlaintextWarning), findsOneWidget);
      // …and it really names the consequence.
      expect(s.exportPlaintextWarning, contains('谁拿到它都能看'));
      c.dispose();
    });

    testWidgets('the sheet also states that the export is only what is still '
        'on this phone (§4.1 scope)', (WidgetTester tester) async {
      const AppStrings s = AppStringsZh();
      final PortableController c = newTestPortableController(rows: testRows(3));
      await tester.pumpWidget(_host(c, s));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(s.exportScopeNote), findsOneWidget);
      expect(find.text(s.exportScopeCount(3)), findsOneWidget);
      c.dispose();
    });

    test('⛔ none of the four languages says 「请妥善保管」 or its equivalents', () {
      for (final AppLocale l in _locales) {
        final AppStrings s = AppStrings(l);
        expect(s.exportPlaintextWarning, isNot(contains('妥善')));
        expect(
          s.exportPlaintextWarning.toLowerCase(),
          isNot(contains('keep it safe')),
        );
        // Every locale must name the CONSEQUENCE, not just the property. The
        // shortest checkable form of that: the sentence has two clauses.
        expect(s.exportPlaintextWarning.length, greaterThan(20), reason: '$l');
      }
    });

    test('every locale has its own warning (no locale copied another)', () {
      // Nine-locale expansion (2026-08-14): `hasLength(4)` under nine locales
      // would require 「exactly 4 distinct」＝ require five of them to be copies,
      // see `support/locale_terms.dart`. measured: this sentence is distinct in
      // all nine locales.
      expectPerLocaleDistinct(
        (AppStrings s) => s.exportPlaintextWarning,
        what: 'exportPlaintextWarning',
      );
    });
  });

  group('§8-2 size next to the checkbox', () {
    testWidgets('🔴 the number comes from the inventory — real file bytes, not '
        'an estimate', (WidgetTester tester) async {
      const AppStrings s = AppStringsZh();
      final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
      await images.put(
        requestId: 'pic-1',
        bytes: Uint8List.fromList(List<int>.filled(2048, 7)),
        extension: 'png',
      );
      // Built by hand rather than by the helper so the SAME blob store backs
      // both the tally and the assertion.
      final PortableController c = PortableController(
        inventory: newTestInventory(
          rows: <TimelineEntry>[
            testRow(
              id: 'loc_d_pic-1',
              clientId: 'pic-1',
              text: '',
              entryType: TimelineEntry.kImage,
            ),
          ],
          images: images,
        ),
        exporter: newTestExporter(images: images),
        importer: newTestImporter(images: images),
      );

      await tester.pumpWidget(_host(c, s));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text(s.exportIncludeImages(1, 2048)), findsOneWidget);
      expect(s.exportIncludeImages(1, 2048), contains(formatBytes(2048)));
      c.dispose();
    });

    testWidgets('a phone with no pictures says so instead of offering a '
        'checkbox that changes nothing', (WidgetTester tester) async {
      const AppStrings s = AppStringsZh();
      final PortableController c = newTestPortableController(rows: testRows(2));
      await tester.pumpWidget(_host(c, s));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(s.exportNoImages), findsOneWidget);
      c.dispose();
    });
  });

  group('§5.2 report wording', () {
    const AppStrings s = AppStringsZh();

    test('a cancel never reads as a failure', () {
      expect(
        exportOutcomeText(const ExportOutcome.cancelled(), s),
        s.exportCancelled,
      );
      expect(exportOutcomeText(const ExportOutcome.cancelled(), s),
          isNot(contains('失败')));
      expect(importReportSentence(const ImportReport.cancelled(), s),
          isNot(contains('失败')));
    });

    test('🔴 a partial import SAYS partial, names every reason, and never '
        'reads as 「完成」', () {
      const ImportReport r = ImportReport(
        added: 2,
        skippedExisting: 1,
        missingAttachments: 1,
        refusedLines: <FprLineRefusal, int>{
          FprLineRefusal.badMode: 1,
          FprLineRefusal.badCreatedAt: 2,
        },
        fileDeclaredAttachments: true,
      );
      final String text = importReportSentence(r, s);
      expect(text, contains('新增 2 条'));
      expect(text, contains('已存在 1 条'));
      expect(text, contains('有 3 行没能导入'));
      expect(text, contains(s.importLineRefusal(FprLineRefusal.badMode)));
      expect(text, contains(s.importLineRefusal(FprLineRefusal.badCreatedAt)));
      expect(text, contains('图片'));
      expect(text, isNot(contains('导入完成')));
    });

    test('the two missing-picture cases read differently (§5.2 table row 4)', () {
      const ImportReport declared = ImportReport(
        added: 1,
        skippedExisting: 0,
        missingAttachments: 1,
        refusedLines: <FprLineRefusal, int>{},
        fileDeclaredAttachments: true,
      );
      const ImportReport notDeclared = ImportReport(
        added: 1,
        skippedExisting: 0,
        missingAttachments: 1,
        refusedLines: <FprLineRefusal, int>{},
        fileDeclaredAttachments: false,
      );
      expect(
        s.importReportText(declared),
        isNot(equals(s.importReportText(notDeclared))),
        reason: '🔴 expected-missing pictures and actually-missing pictures must read differently',
      );
      // 2026-08-11 import-copy fix (docs/strategy/
      // 2026-08-11-import-false-no-pictures-copy.md): the old sentence here
      // (「…本来就没有包含图片，只恢复了文字」) claimed text-only recovery while
      // `thumb_b64` still restores a visible picture with the row — a false
      // report. The copy now names what is actually missing (the full
      // original), and this expectation follows it; the desktop twin
      // (portable-copy.test.ts) was updated in that window, this line was
      // missed and briefly stayed red on main (two FABLE lanes caught it
      // independently the same day).
      expect(s.importReportText(notDeclared), contains('未包含完整原图'));
      expect(
        s.importReportText(notDeclared),
        isNot(contains('只恢复了文字')),
        reason: '§5.2 forbids the old lie: thumb_b64 still restores with the row; it is not 「只恢复了文字」',
      );
    });

    test('every FprLineRefusal has a named sentence in all four languages, and '
        'no two reasons in one language collapse into the same words', () {
      for (final AppLocale l in _locales) {
        final AppStrings st = AppStrings(l);
        final Set<String> seen = <String>{};
        for (final FprLineRefusal r in FprLineRefusal.values) {
          final String text = st.importLineRefusal(r);
          expect(text.trim(), isNotEmpty, reason: '$l/$r');
          expect(seen.add(text), isTrue, reason: '$l: two reasons read alike ($r)');
        }
      }
    });

    test('every FprFileRefusal has a sentence, and cross-end names the other '
        'end', () {
      for (final AppLocale l in _locales) {
        final AppStrings st = AppStrings(l);
        for (final FprFileRefusal r in FprFileRefusal.values) {
          expect(st.importFileRefusal(r, 'desktop', null).trim(), isNotEmpty);
        }
      }
      expect(
        AppStrings(AppLocale.zh)
            .importFileRefusal(FprFileRefusal.crossEnd, 'desktop', null),
        contains('电脑'),
      );
    });

    test('every ExportFailure has a sentence in all four languages', () {
      for (final AppLocale l in _locales) {
        for (final ExportFailure f in ExportFailure.values) {
          expect(AppStrings(l).exportFailedText(f, null).trim(), isNotEmpty);
        }
      }
    });
  });

  group('§3 README contents', () {
    test('all four of the required things are in it', () {
      for (final AppLocale l in _locales) {
        final AppStrings s = AppStrings(l);
        final String text = s.portableReadme(
          exportedAt: '2026-08-01T09:00:00.000Z',
          entryCount: 12,
          attachmentCount: 3,
          hasAttachments: true,
          appVersion: '0.2.36',
        );
        expect(text, contains('FlowMic'));
        expect(text, contains(s.exportPlaintextWarning));
        expect(text, contains(kFprRecordsName));
        expect(text, contains('2026-08-01T09:00:00.000Z'));
        expect(text, contains('12'));
      }
    });

    test('a version we could not read simply is not mentioned', () {
      final String text = AppStrings(AppLocale.zh).portableReadme(
        exportedAt: 'x',
        entryCount: 1,
        attachmentCount: 0,
        hasAttachments: false,
        appVersion: null,
      );
      expect(text, isNot(contains('版本')));
    });
  });

  // ── 🔴 anti-façade: the two entry points are REAL on the settings screen ──────
  //
  // The rule this repo enforces is 「grep the production caller」. For a UI surface the
  // equivalent is: the row exists on the page a user can reach, and pressing it
  // drives the SAME controller production wires — not a second one built for the
  // test. The probe is [FixedImportSource.calls]: 0 before the tap, 1 after,
  // which can only happen if the tap reached PortableController.import().
  //
  // ⚠️ TEARDOWN IS `addTearDown`, NOT INLINE — and that is load-bearing, not
  // style. Disposing these controllers inside the test BODY hangs the whole
  // file: `SettingsClient.dispose()` awaits `_entriesCtl.close()`, and a
  // single-subscription StreamController's `close()` future does not complete
  // while the test body still holds the async guard. Measured, not guessed — an
  // instrumented run printed every step and stopped exactly between 「snackbar
  // expired」 and 「controllers disposed」, and a 90 s wall-clock `timeout`
  // wrapper confirmed it never returns. A hung test is worse than a red one: it
  // takes the whole suite's output with it (CLAUDE.md real-device debug technique).
  group('settings page · data section', () {
    testWidgets('export / import both render, and the import button really runs the '
        'importer', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
      addTearDown(appSettings.dispose);
      await appSettings.load();
      final FakeSocketTransport transport = FakeSocketTransport();
      addTearDown(transport.close);
      final SettingsClient settingsClient = SettingsClient(transport: transport);
      addTearDown(settingsClient.dispose);
      final ScenarioCardController scenario = ScenarioCardController(
        settingsClient: settingsClient,
        cache: InMemoryScenarioCardCache(),
      );
      addTearDown(scenario.dispose);
      await scenario.load();
      final PttSession session = newTestSession(
        transport: FakeSocketTransport(),
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      addTearDown(session.dispose);
      final LoginController login = newTestLogin(transport: session.transport);
      addTearDown(login.dispose);
      final DestinationController destination = DestinationController();
      addTearDown(destination.dispose);
      // `path: null` = the user backed out of the picker. The double COUNTS the
      // call, which is the probe below.
      final FixedImportSource picker = FixedImportSource(null);
      final PortableController portable = newTestPortableController(
        rows: testRows(2),
        source: picker,
      );
      addTearDown(portable.dispose);
      final AppStrings s = AppStrings(appSettings.locale);

      await tester.pumpWidget(
        MaterialApp(
          home: SettingsPage(
            scenario: scenario,
            appSettings: appSettings,
            login: login,
            destination: destination,
            session: session,
            portable: portable,
            inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
            timeline: newTestStore(),
            version: const FixedAppVersion('0.0.0-test'),
            update: newTestUpdateController(),
          ),
        ),
      );
      await tester.pump();

      // The settings page is a ListView and the data section sits below the fold
      // on a phone-sized surface, so it has to be scrolled into existence — a
      // lazily-built child is not in the tree at all.
      //
      // 🔴 W5a (P-7) — THIS RIG HAS NOW BITTEN TWICE FOR THE SAME REASON, so it
      // is being fixed instead of re-tuned. The old shape scrolled to
      // `importTitle` once and then asserted that the data HEADER — a different
      // widget, further up — happened to still be on screen. That co-visibility
      // was never asserted by anything; it was a property of where
      // `scrollUntilVisible`'s fixed 200px steps happened to stop, which in turn
      // depends on the list's total extent. Card U9 added a 关于 row below and
      // knocked it out once (patched then with a 500ms settle); P-7 added the
      // 「查看使用引导」row below and knocked it out again, settle and all —
      // `Found 0 widgets with text "数据"`, while the section itself rendered
      // perfectly.
      // ⇒ rule: when asserting a widget is 「on screen」, scroll THAT widget onto
      //   the screen; do not rely on 「it happens to still be there after scrolling
      //   to another widget」. The latter's truth depends on how many rows sit
      //   **elsewhere** on the page, so any unrelated change knocks it over, and
      //   the red looks as if this section itself broke.
      await tester.scrollUntilVisible(find.text(s.secData.toUpperCase()), 200);
      await tester.pumpAndSettle();
      // `settingsSection` upper-cases its label, same as every other section.
      expect(find.text(s.secData.toUpperCase()), findsOneWidget);

      await tester.scrollUntilVisible(find.text(s.importTitle), 200);
      await tester.pumpAndSettle();
      expect(find.text(s.exportTitle), findsOneWidget);
      expect(find.text(s.importTitle), findsOneWidget);

      // Negative-then-positive: nobody asked the picker yet…
      expect(picker.calls, 0);
      await tester.tap(find.text(s.importAction));
      // Deliberately pump() rather than pumpAndSettle(): the report snackbar
      // holds a 6 s timer, and settling on it would wait on that timer.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      // …and now they have.
      expect(
        picker.calls,
        1,
        reason: 'the button must reach the real controller, not nothing',
      );
      expect(find.text(s.importCancelled), findsOneWidget);
      // Let the snackbar's own timer expire so no timer is pending at teardown.
      await tester.pump(const Duration(seconds: 7));
    });
  });
}
