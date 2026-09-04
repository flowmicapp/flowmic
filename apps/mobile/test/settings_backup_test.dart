// 2026-09-03 (WP-B item 5, design D9) — the settings backup file.
//
// Four claims, each a case below, all over REAL mock SharedPreferences and the
// REAL SettingsBackup (the file dialog is the only double, and it is a
// recording one — the archive it is handed is copied where a test can read it):
//   · round trip: export → wipe the store → import ⇒ every key equal, key by
//     key, including 「never set」 rows staying never-set;
//   · cross-end refusal: a file whose `source.end` is not "mobile" touches
//     nothing and says which end it came from;
//   · unknown keys: a newer file's extra keys are kept and written back into
//     the next export, without error;
//   · the first-run markers are NEVER written by an import.
//
// ── REVERSE CONTROL (executed 2026-09-03) ──────────────────────────────────
// Break: in `restoreFrom`, move the `source.end` check AFTER the key loop.
// OBSERVED: 「a PC export is refused and nothing is written」 goes red
// (Expected: 'zh' Actual: 'ja' on the spoken language) — the refusal sentence
// still appeared, but the store had already been overwritten, which is the
// silent half of the failure the check exists to prevent.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/portable/settings_backup.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/settings/prefs_controller.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/portable_fakes.dart';

/// The preference keys a backup covers, plus the two it must never touch.
const List<String> kCoveredKeys = <String>[
  SharedPrefsScenarioCardCache.cacheKey,
  SharedPrefsPrefsStore.polishKey,
  SharedPrefsPrefsStore.refineKey,
  SharedPrefsPrefsStore.inferenceKey,
  AppSettingsController.kSpokenLangKey,
  AppSettingsController.kLocaleKey,
  AppSettingsController.kThemeModeKey,
  AppSettingsController.kTextScaleKey,
  kSendPolicyKey,
  kTranslateTargetKey,
  kFavoritesKey,
];

class _Harness {
  late final Directory tmp;
  late final SharedPreferences prefs;
  late final RecordingExportDestination dest;
  late final FixedImportSource source;
  late final SettingsBackup backup;
  int imported = 0;

  static Future<_Harness> create(Map<String, Object> seed) async {
    final _Harness h = _Harness();
    h.tmp = await Directory.systemTemp.createTemp('flowmic-settings-backup-');
    SharedPreferences.setMockInitialValues(seed);
    h.prefs = await SharedPreferences.getInstance();
    h.dest = RecordingExportDestination('${h.tmp.path}/out');
    h.source = FixedImportSource(null);
    h.backup = SettingsBackup(
      prefs: h.prefs,
      destination: h.dest,
      source: h.source,
      version: const FixedAppVersion('0.0.0-test'),
      workDir: h.tmp.path,
      deviceName: 'TestPhone-0000',
      onImported: () async => h.imported += 1,
    );
    return h;
  }

  Map<String, Object?> snapshotOfStore() => <String, Object?>{
    for (final String k in kCoveredKeys) k: prefs.get(k),
  };

  Future<void> dispose() async {
    await tmp.delete(recursive: true);
  }
}

/// A fully populated phone: every covered key set, plus the first-run markers
/// in their settled state and one key nothing should ever export.
Map<String, Object> _populated() => <String, Object>{
  SharedPrefsScenarioCardCache.cacheKey: jsonEncode(<String, Object?>{
    'professions': <String>['law'],
    'domains': <String>['legal'],
    'packs': <String>['tech-dev'],
    'terms': <Object>['幂等', <String, Object?>{'term': 'FlowMic', 'aliases': <String>['flow mic']}],
  }),
  SharedPrefsPrefsStore.polishKey: jsonEncode(<String, Object?>{'enabled': false, 'strength': 'smooth'}),
  SharedPrefsPrefsStore.refineKey: jsonEncode(<String, Object?>{'enabled': true}),
  SharedPrefsPrefsStore.inferenceKey: jsonEncode(<String, Object?>{'granted': true, 'granted_for': 'external'}),
  AppSettingsController.kSpokenLangKey: 'ja',
  AppSettingsController.kLocaleKey: 'de',
  AppSettingsController.kThemeModeKey: 'dark',
  AppSettingsController.kTextScaleKey: 'small',
  kSendPolicyKey: 'manual',
  kTranslateTargetKey: 'fr',
  kFavoritesKey: <String>['稍等一下', 'on my way'],
  'flowmic.pref.locale_prompt': 'settled',
  'flowmic.pref.onboarding_seen': 'true',
  'flowmic.mobile.token': 'SECRET-never-exported',
};

void main() {
  test('the file has the D9 shape: header, source.end=mobile, prefs under wire keys, local habits', () async {
    final _Harness h = await _Harness.create(_populated());
    addTearDown(h.dispose);
    final Map<String, Object?> doc = await h.backup.snapshot(exportedAt: DateTime.utc(2026, 9, 3, 7, 33));
    expect(doc['flowmic_settings'], 1);
    expect(doc['exported_at'], '2026-09-03T07:33:00.000Z');
    expect(doc['source'], <String, Object?>{
      'app': 'flowmic', 'end': 'mobile', 'version': '0.0.0-test', 'device': 'TestPhone-0000',
    });
    final Map<String, Object?> prefs = (doc['prefs']! as Map).cast<String, Object?>();
    expect(prefs.keys, unorderedEquals(<String>[
      FlowMicSettingsKeys.scenarioCard,
      FlowMicSettingsKeys.sttPolish,
      FlowMicSettingsKeys.sttRefine,
      FlowMicSettingsKeys.scenarioInference,
      'spoken_lang',
    ]));
    expect((prefs[FlowMicSettingsKeys.scenarioCard]! as Map)['terms'], <Object>[
      '幂等',
      <String, Object?>{'term': 'FlowMic', 'aliases': <String>['flow mic']},
    ]);
    expect(prefs[FlowMicSettingsKeys.sttPolish], <String, Object?>{'enabled': false, 'strength': 'smooth'});
    expect(prefs['spoken_lang'], 'ja');
    expect(doc['local'], <String, Object?>{
      'locale': 'de', 'theme': 'dark', 'text_scale': 'small',
      'send_policy': 'manual', 'translate_target': 'fr',
      'favorites': <String>['稍等一下', 'on my way'],
    });
    final String text = jsonEncode(doc);
    expect(text, isNot(contains('SECRET')), reason: 'credentials are never in a settings file');
    expect(text, isNot(contains('locale_prompt')));
    expect(text, isNot(contains('onboarding_seen')));
    expect(SettingsBackup.fileNameFor(DateTime(2026, 9, 3, 7, 5, 9)), 'flowmic-settings-20260903-070509.json');
  });

  test('round trip: export → wipe → import ⇒ every covered key equal, key by key; '
      'the first-run markers are untouched on both sides', () async {
    final _Harness h = await _Harness.create(_populated());
    addTearDown(h.dispose);
    final Map<String, Object?> before = h.snapshotOfStore();

    final SettingsBackupOutcome out = await h.backup.export();
    expect(out.ok, isTrue, reason: out.detail);
    expect(out.landing!.displayPath, h.dest.savedPath);
    expect(File(h.dest.savedPath!).existsSync(), isTrue);
    expect(h.dest.savedFileName, startsWith('flowmic-settings-'));

    // Wipe: every covered key gone, the markers set to the OTHER state so a
    // write to them would be visible.
    for (final String k in kCoveredKeys) {
      await h.prefs.remove(k);
    }
    await h.prefs.setString('flowmic.pref.locale_prompt', 'pending');
    await h.prefs.remove('flowmic.pref.onboarding_seen');
    expect(h.snapshotOfStore().values.every((Object? v) => v == null), isTrue, reason: 'setup: wiped');

    h.source.path = h.dest.savedPath;
    final SettingsRestoreOutcome res = await h.backup.import();
    expect(res.ok, isTrue, reason: '${res.refusal} ${res.detail}');
    expect(res.keysWritten, 11);
    expect(h.imported, 1, reason: 'the composition root was told exactly once');

    final Map<String, Object?> after = h.snapshotOfStore();
    for (final String k in kCoveredKeys) {
      final Object? want = before[k];
      final Object? got = after[k];
      // JSON-holding keys are compared as decoded documents (the exporter may
      // re-serialise a card written by an older build); the rest byte for byte.
      if (want is String && want.startsWith('{')) {
        expect(jsonDecode(got! as String), jsonDecode(want), reason: k);
      } else {
        expect(got, want, reason: k);
      }
    }
    for (final String marker in AppSettingsController.firstRunMarkerKeys) {
      expect(marker, anyOf('flowmic.pref.locale_prompt', 'flowmic.pref.onboarding_seen'));
    }
    expect(h.prefs.getString('flowmic.pref.locale_prompt'), 'pending',
        reason: '🔴 an import must never settle or re-open the language question');
    expect(h.prefs.getString('flowmic.pref.onboarding_seen'), isNull,
        reason: '🔴 an import must never mark onboarding as seen');
  });

  test('a never-set row is ABSENT in the file and stays never-set after import '
      '(absence is not 「off」)', () async {
    final _Harness h = await _Harness.create(<String, Object>{
      SharedPrefsPrefsStore.refineKey: jsonEncode(<String, Object?>{'enabled': true}),
      'flowmic.pref.locale_prompt': 'settled',
    });
    addTearDown(h.dispose);
    final Map<String, Object?> doc = await h.backup.snapshot();
    final Map<String, Object?> prefs = (doc['prefs']! as Map).cast<String, Object?>();
    expect(prefs.containsKey(FlowMicSettingsKeys.sttPolish), isFalse);
    expect(prefs[FlowMicSettingsKeys.sttRefine], <String, Object?>{'enabled': true});

    // Plant a polish row, then import the file that says nothing about polish.
    await h.prefs.setString(SharedPrefsPrefsStore.polishKey, jsonEncode(<String, Object?>{'enabled': false}));
    final SettingsRestoreOutcome res = await h.backup.restoreFrom(jsonEncode(doc));
    expect(res.ok, isTrue);
    expect(h.prefs.getString(SharedPrefsPrefsStore.polishKey), isNotNull,
        reason: 'a key the file does not mention is left alone');
  });

  test('a PC export is refused, names the end, and NOTHING is written', () async {
    final _Harness h = await _Harness.create(<String, Object>{
      AppSettingsController.kSpokenLangKey: 'zh',
    });
    addTearDown(h.dispose);
    final String pcFile = jsonEncode(<String, Object?>{
      'flowmic_settings': 1,
      'exported_at': '2026-09-03T00:00:00.000Z',
      'source': <String, Object?>{'app': 'flowmic', 'end': 'pc'},
      'prefs': <String, Object?>{'spoken_lang': 'ja'},
      'local': <String, Object?>{'locale': 'ja'},
    });
    final SettingsRestoreOutcome res = await h.backup.restoreFrom(pcFile);
    expect(res.ok, isFalse);
    expect(res.refusal, SettingsRestoreRefusal.otherEnd);
    expect(res.otherEnd, 'pc');
    expect(h.prefs.getString(AppSettingsController.kSpokenLangKey), 'zh');
    expect(h.prefs.getString(AppSettingsController.kLocaleKey), isNull);
    expect(h.imported, 0, reason: 'a refusal is not an import');
  });

  test('not a settings file / a newer format ⇒ refused by name; a cancelled pick is a cancel', () async {
    final _Harness h = await _Harness.create(<String, Object>{});
    addTearDown(h.dispose);
    expect((await h.backup.restoreFrom('not json')).refusal, SettingsRestoreRefusal.notASettingsFile);
    expect((await h.backup.restoreFrom('{"records": 1}')).refusal, SettingsRestoreRefusal.notASettingsFile);
    expect(
      (await h.backup.restoreFrom(jsonEncode(<String, Object?>{
        'flowmic_settings': 2,
        'source': <String, Object?>{'end': 'mobile'},
      }))).refusal,
      SettingsRestoreRefusal.newerFormat,
    );
    final SettingsRestoreOutcome cancelled = await h.backup.import();
    expect(cancelled.cancelled, isTrue);
    expect(cancelled.ok, isFalse);
  });

  test('unknown keys are preserved without error and ride the next export', () async {
    final _Harness h = await _Harness.create(<String, Object>{});
    addTearDown(h.dispose);
    final String newer = jsonEncode(<String, Object?>{
      'flowmic_settings': 1,
      'exported_at': '2026-09-03T00:00:00.000Z',
      'source': <String, Object?>{'app': 'flowmic', 'end': 'mobile'},
      'prefs': <String, Object?>{
        'spoken_lang': 'ko',
        'stt.future_thing': <String, Object?>{'enabled': true},
      },
      'local': <String, Object?>{'locale': 'ko', 'haptics': 'strong'},
      'experimental': <String, Object?>{'x': 1},
    });
    final SettingsRestoreOutcome res = await h.backup.restoreFrom(newer);
    expect(res.ok, isTrue);
    expect(res.keysWritten, 2, reason: 'the two known keys; the rest kept, not counted');
    expect(h.prefs.getString(AppSettingsController.kSpokenLangKey), 'ko');
    expect(h.prefs.getString(AppSettingsController.kLocaleKey), 'ko');

    final Map<String, Object?> doc = await h.backup.snapshot();
    expect((doc['prefs']! as Map)['stt.future_thing'], <String, Object?>{'enabled': true});
    expect((doc['local']! as Map)['haptics'], 'strong');
    expect(doc['experimental'], <String, Object?>{'x': 1});
  });

  test('a known key with an unparseable value is kept aside, not half-written', () async {
    final _Harness h = await _Harness.create(<String, Object>{
      AppSettingsController.kLocaleKey: 'en',
    });
    addTearDown(h.dispose);
    final SettingsRestoreOutcome res = await h.backup.restoreFrom(jsonEncode(<String, Object?>{
      'flowmic_settings': 1,
      'source': <String, Object?>{'end': 'mobile'},
      'prefs': <String, Object?>{
        'stt.polish': <String, Object?>{'enabled': true, 'strength': 'loud'},
        'spoken_lang': 'klingon',
      },
      'local': <String, Object?>{'locale': 'elvish', 'text_scale': 'medium'},
    }));
    expect(res.ok, isTrue);
    expect(res.keysWritten, 2, reason: 'polish (with its strength normalised) and text_scale');
    expect(h.prefs.getString(SharedPrefsPrefsStore.polishKey),
        jsonEncode(<String, Object?>{'enabled': true, 'strength': 'strict'}),
        reason: 'an unknown strength reads as strict at the boundary, like the protocol does');
    expect(h.prefs.getString(AppSettingsController.kSpokenLangKey), isNull);
    expect(h.prefs.getString(AppSettingsController.kLocaleKey), 'en');
    expect(h.prefs.getString(AppSettingsController.kTextScaleKey), 'medium');
  });

  test('a stamped-era envelope cache exports as a plain card (the stamp is dropped)', () async {
    final _Harness h = await _Harness.create(<String, Object>{
      SharedPrefsScenarioCardCache.cacheKey: jsonEncode(<String, Object?>{
        'card': <String, Object?>{'professions': <String>['law'], 'domains': <String>[], 'packs': <String>[], 'terms': <String>['A']},
        'updated_at': '2026-08-16T09:00:00.000Z',
      }),
    });
    addTearDown(h.dispose);
    final Map<String, Object?> doc = await h.backup.snapshot();
    expect((doc['prefs']! as Map)[FlowMicSettingsKeys.scenarioCard], <String, Object?>{
      'professions': <String>['law'], 'domains': <String>[], 'packs': <String>[], 'terms': <Object>['A'],
    });
    expect(ScenarioCard.fromJson((doc['prefs']! as Map)[FlowMicSettingsKeys.scenarioCard]).professions, <String>['law']);
  });

  // ── profession/domain ids (2026-09-04) ────────────────────────────────────
  test('a legacy backup file whose card carries LOCALE LABELS restores as ids, '
      'and the duplicate-language entries collapse', () async {
    final _Harness h = await _Harness.create(<String, Object>{});
    addTearDown(h.dispose);
    final SettingsRestoreOutcome res = await h.backup.restoreFrom(jsonEncode(<String, Object?>{
      'flowmic_settings': 1,
      'source': <String, Object?>{'app': 'flowmic', 'end': 'mobile'},
      'prefs': <String, Object?>{
        FlowMicSettingsKeys.scenarioCard: <String, Object?>{
          // A phone used in Chinese and then in German, exported before ids.
          'professions': <String>['软件开发', 'software development', 'Recht'],
          'domains': <String>['Cloud-nativ', 'data / ML', 'astrology'],
          'packs': <String>['tech-dev'],
          'terms': <Object>['灰度发布'],
        },
      },
    }));
    expect(res.ok, isTrue);
    final ScenarioCard restored =
        await SharedPrefsScenarioCardCache(h.prefs).load();
    expect(restored.professions, <String>['software-dev', 'law']);
    expect(restored.domains, <String>['cloud-native', 'data-ml'],
        reason: 'astrology is not a domain and is dropped, not kept');
    expect(restored.packs, <String>['tech-dev']);
    expect(restored.termNames, <String>['灰度发布']);
  });

  test('export writes IDS, and a store still holding pre-id labels is migrated '
      'on the way out (an export must never carry the duplicates forward)',
      () async {
    final _Harness h = await _Harness.create(<String, Object>{
      SharedPrefsScenarioCardCache.cacheKey: jsonEncode(<String, Object?>{
        'professions': <String>['产品设计', 'product design'],
        'domains': <String>['前端'],
        'packs': <String>[],
        'terms': <Object>[],
      }),
    });
    addTearDown(h.dispose);
    final Map<String, Object?> doc = await h.backup.snapshot();
    final Map<Object?, Object?> card =
        (doc['prefs']! as Map)[FlowMicSettingsKeys.scenarioCard] as Map<Object?, Object?>;
    expect(card['professions'], <String>['product-design']);
    expect(card['domains'], <String>['frontend']);
  });

  test('the id round trip: export ids -> wipe -> import ⇒ the same ids, and '
      '`flowmic_settings` is still format 1', () async {
    final _Harness h = await _Harness.create(<String, Object>{
      SharedPrefsScenarioCardCache.cacheKey: jsonEncode(<String, Object?>{
        'professions': <String>['software-dev', 'law'],
        'domains': <String>['data-ml'],
        'packs': <String>[],
        'terms': <Object>[],
      }),
    });
    addTearDown(h.dispose);
    final Map<String, Object?> doc = await h.backup.snapshot();
    expect(doc['flowmic_settings'], 1);
    await h.prefs.remove(SharedPrefsScenarioCardCache.cacheKey);
    expect((await h.backup.restoreFrom(jsonEncode(doc))).ok, isTrue);
    final ScenarioCard back = await SharedPrefsScenarioCardCache(h.prefs).load();
    expect(back.professions, <String>['software-dev', 'law']);
    expect(back.domains, <String>['data-ml']);
  });
}
