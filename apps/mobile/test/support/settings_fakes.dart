// Test doubles for the phone-owned settings family (2026-09-03).
//
// 🔴 LEGITIMATE doubles, not the friendly production defaults 13 册 §7 F1 ②
// bans: [FakeSettingsBackup] COUNTS what the page asked of it and answers
// 「cancelled」 — which is the truth about what it did — so a widget test can
// prove the row reached the port (a count of zero is not something a passing
// assertion can be confused about) without any file dialog. The real
// round-trip is proven on [SettingsBackup] itself over mock SharedPreferences
// (settings_backup_test.dart). They exist only under test/ and have no
// production construction site.

import 'package:flowmic/src/portable/settings_backup.dart';
import 'package:flowmic/src/settings/prefs_controller.dart';

/// A [PrefsController] over an in-memory store. It has no wire: since
/// 2026-09-03 the preferences ride `audio:start` / `compose:start`, so a
/// controller is a local store and nothing else.
PrefsController newTestPrefsController({PhonePrefs initial = PhonePrefs.empty}) =>
    PrefsController(store: InMemoryPrefsStore(initial));

/// 「the user pressed back」 on both verbs, and a count of how often each was
/// asked — the anti-façade probe for the two settings rows on the data card.
class FakeSettingsBackup implements SettingsBackupPort {
  int exportCalls = 0;
  int importCalls = 0;

  @override
  Future<SettingsBackupOutcome> export() async {
    exportCalls += 1;
    return const SettingsBackupOutcome.cancelled();
  }

  @override
  Future<SettingsRestoreOutcome> import() async {
    importCalls += 1;
    return const SettingsRestoreOutcome.cancelled();
  }
}

FakeSettingsBackup newTestSettingsBackup() => FakeSettingsBackup();
