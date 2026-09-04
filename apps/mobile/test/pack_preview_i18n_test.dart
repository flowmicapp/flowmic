// W-i18n-A — dictionary-pack row subtitles are catalogue copy, not the
// Chinese STT seed terms that gen_protocol.mjs copies into
// FlowMicDictionaryPack.preview.
//
// The seed terms stay Chinese (they are recognizer hotwords). The settings
// row used to paint `packs[i].preview` as `sub:`, so every UI locale showed
// 心电图 / 合同 / 财报. The render site now goes through AppStrings.packPreview,
// same per-id lookup shape as packLabel, with the generated preview as the
// unknown-id fallback so a new pack never renders blank.
//
// ── REVERSE CONTROL (measured, red, restored, green) ─────────────────────
// Revert the render site in settings_page.dart to `sub: packs[i].preview`,
// run this file; the no-CJK-under-en widget test MUST fail. Restored;
// leftover marker `REVERSE-CONTROL-I18N-A` grep = 0 under apps/mobile/lib.

import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

/// Han + CJK Ext-A. The seed-term leak this card closes is in this range
/// (心电图 / 合同 / 财报). Latin, middle-dot, ellipsis, Cyrillic, Hangul,
/// and kana are outside it — an English subtitle that names "CT" or "M&A"
/// must not trip this.
final RegExp kHan = RegExp(r'[\u4e00-\u9fff\u3400-\u4dbf]');

const AppStrings _en = AppStringsEn();
const AppStrings _zh = AppStringsZh();

const List<String> kCjkLeakPackIds = <String>['medical', 'legal', 'finance'];

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
    r.settingsJoins = ValueNotifier<int>(0);
    r.settingsClient = SettingsClient(
      transport: r.settingsTransport,
      roomJoins: r.settingsJoins,
    );
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
          portable: newTestPortableController(),
          prefs: newTestPrefsController(),
          backup: newTestSettingsBackup(),
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
    await settingsTransport.close();
  }
}

Future<void> _pumpSettings(WidgetTester tester, _Rig rig) async {
  tester.view.physicalSize = const Size(1200, 4200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(rig.widget());
  await tester.pumpAndSettle();
}

/// Subtitle painted under [title] on a settingsCheckRow (title Text, then
/// the sub Text). Walks the nearest Column — that is the production row,
/// not a hand-built stand-in.
String _subtitleUnder(WidgetTester tester, String title) {
  final Finder titleFinder = find.text(title);
  expect(titleFinder, findsOneWidget, reason: 'pack title "$title" must be on screen');
  final Element titleEl = titleFinder.evaluate().single;
  final Column? col = titleEl.findAncestorWidgetOfExactType<Column>();
  expect(col, isNotNull, reason: 'pack title "$title" must sit in the check-row Column');
  final List<Text> texts = col!.children.whereType<Text>().toList();
  expect(
    texts.length,
    greaterThanOrEqualTo(2),
    reason: 'pack row "$title" must paint a subtitle',
  );
  return texts[1].data ?? '';
}

void main() {
  testWidgets(
    'EN: medical/legal/finance pack subtitles contain no Han characters',
    (WidgetTester tester) async {
      final _Rig rig = await _Rig.create();
      addTearDown(rig.dispose);
      rig.appSettings.setLocale(AppLocale.en);
      await _pumpSettings(tester, rig);

      for (final String id in kCjkLeakPackIds) {
        final FlowMicDictionaryPack pack = FlowMicDictionaryPacks.all.firstWhere(
          (FlowMicDictionaryPack p) => p.id == id,
        );
        final String title = _en.packLabel(pack.id, pack.label);
        final String sub = _subtitleUnder(tester, title);
        expect(
          kHan.hasMatch(sub),
          isFalse,
          reason: 'EN subtitle for pack "$id" leaked Han: "$sub"',
        );
      }
    },
  );

  testWidgets(
    'zh-CN: medical/legal/finance pack subtitles still show the Chinese terms',
    (WidgetTester tester) async {
      final _Rig rig = await _Rig.create();
      addTearDown(rig.dispose);
      rig.appSettings.setLocale(AppLocale.zh);
      await _pumpSettings(tester, rig);

      expect(_subtitleUnder(tester, _zh.packLabel('medical', 'Medical terms')),
          '心电图 · 核磁共振 · CT · 血常规 …');
      expect(_subtitleUnder(tester, _zh.packLabel('legal', 'Legal terms')),
          '合同 · 诉讼 · 仲裁 · 律师 …');
      expect(_subtitleUnder(tester, _zh.packLabel('finance', 'Finance terms')),
          '财报 · 估值 · 融资 · 并购 …');
    },
  );

  test('unknown pack id falls back to the generated preview, never blank', () {
    const String generated = '心电图 · 核磁共振 · CT · 血常规 …';
    expect(_en.packPreview('brand-new-pack', generated), generated);
    expect(_zh.packPreview('brand-new-pack', generated), generated);
    expect(_en.packPreview('brand-new-pack', generated), isNotEmpty);
  });

  test('known pack ids under EN are the catalogue descriptions, not the seeds', () {
    final FlowMicDictionaryPack medical = FlowMicDictionaryPacks.all.firstWhere(
      (FlowMicDictionaryPack p) => p.id == 'medical',
    );
    expect(_en.packPreview(medical.id, medical.preview), 'ECG - MRI - CT - blood panel …');
    expect(kHan.hasMatch(_en.packPreview(medical.id, medical.preview)), isFalse);
    expect(kHan.hasMatch(medical.preview), isTrue,
        reason: 'the generated preview is still the Chinese seeds — we must not have translated them');
  });
}
