// SPEC-REF:
//   apps/mobile/lib/src/settings/local_prefs.dart (this file copies its
//     posture and its reasoning)
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §5.0 / §5.1
//   CLAUDE.md red line: settings apply-and-save-immediately, no save button
//
// The 「auto-check for updates」 switch, and 「when the last successful check happened」.
//
// ── why shared_preferences directly, rather than settings.set ────────────────────
//
// The exact same reason as `local_prefs.dart` (that file's own header states
// it verbatim): these two keys are
// **this phone's own business**, never synced, never sent to the cloud.
// Going through `settings.set(...)` would make
// `verify/lint/settings-key-drift.mjs` demand the server have a
// corresponding reader —
// and a phone-local update preference **has none**, and should not have one.
//
// ⚠️ Deliberately **NOT** folded into `local_prefs.dart`'s `LocalPrefs`
// interface: that would make one card touch
// the abstract class + two implementations, three places at once, and that
// file is a shared file other surfaces use. Same posture, separate gates.
//
// ── 🔴 「last successful check」 is not decoration ─────────────────────────────────────────
//
// Design §5.0's closing note: **it is the ONLY piece of evidence behind the
// sentence 「already up to date」**. Without it, a client that has
// **never once checked successfully** and a client that **just checked** look
// identical on screen.
// ⇒ Either both of these ship together, or neither does.

import 'package:shared_preferences/shared_preferences.dart';

/// Automatically check for updates. **Default ON** — owner's own words were
/// 「the phone side **automatically detects** whether an upgrade is needed」
/// (`docs/decisions/2026-08-02-in-app-update-both-ends.md`). Turning it off
/// is the user's
/// opt-out, and also the privacy stance for self-hosted users (the card
/// states explicitly 「respect self-hosting」).
const String kUpdateAutoCheckKey = 'flowmic.update.auto_check';

/// The instant (epoch ms) of the last time a version comparison
/// **genuinely produced a conclusion**. **Does NOT store what the
/// conclusion was.**
///
/// 🔴 Storing only the instant, not the conclusion, is deliberate: the
/// conclusion goes stale, but 「when it was asked」 does not.
/// If 「already up to date」 were also persisted, the App would show
/// 「already up to date」 the instant it launches, **before it has even
/// checked** — that is passing off a three-day-old answer as today's fact,
/// exactly what this chain exists to block.
const String kUpdateLastSuccessAtKey = 'flowmic.update.last_success_at';

/// The minimum interval for auto-check. Design §Phone side: 「at launch (+ every 24h)」.
const Duration kUpdateCheckInterval = Duration(hours: 24);

abstract class UpdatePrefs {
  /// Default true (see [kUpdateAutoCheckKey]).
  Future<bool> autoCheckEnabled();
  Future<void> setAutoCheckEnabled(bool enabled);

  /// null = **never successfully checked**. This is a state that must be spoken out loud, not 「a long time ago」.
  Future<DateTime?> lastSuccessAt();
  Future<void> setLastSuccessAt(DateTime at);
}

class InMemoryUpdatePrefs implements UpdatePrefs {
  InMemoryUpdatePrefs({bool autoCheck = true, DateTime? lastSuccess})
      : _autoCheck = autoCheck,
        _lastSuccess = lastSuccess;
  bool _autoCheck;
  DateTime? _lastSuccess;

  @override
  Future<bool> autoCheckEnabled() async => _autoCheck;

  @override
  Future<void> setAutoCheckEnabled(bool enabled) async => _autoCheck = enabled;

  @override
  Future<DateTime?> lastSuccessAt() async => _lastSuccess;

  @override
  Future<void> setLastSuccessAt(DateTime at) async => _lastSuccess = at;
}

class SharedPrefsUpdatePrefs implements UpdatePrefs {
  SharedPrefsUpdatePrefs(this._prefs);
  final SharedPreferences _prefs;

  @override
  Future<bool> autoCheckEnabled() async =>
      _prefs.getBool(kUpdateAutoCheckKey) ?? true;

  @override
  Future<void> setAutoCheckEnabled(bool enabled) async {
    await _prefs.setBool(kUpdateAutoCheckKey, enabled);
  }

  @override
  Future<DateTime?> lastSuccessAt() async {
    final int? ms = _prefs.getInt(kUpdateLastSuccessAtKey);
    // 0 / a negative number means 「written corrupt」, not 「checked once in
    // 1970」 — treated as never checked,
    // because 「never checked」 is the only honest fallback on this chain.
    if (ms == null || ms <= 0) return null;
    return DateTime.fromMillisecondsSinceEpoch(ms);
  }

  @override
  Future<void> setLastSuccessAt(DateTime at) async {
    await _prefs.setInt(kUpdateLastSuccessAtKey, at.millisecondsSinceEpoch);
  }
}
