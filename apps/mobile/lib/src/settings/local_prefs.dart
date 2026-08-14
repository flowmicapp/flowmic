// SPEC-REF:
//   CLAUDE.md red line: settings apply-and-persist immediately, no save button
//
// Device-local preferences that MUST NOT touch the settings-sync store. These
// are deliberately persisted through shared_preferences directly (getBool/
// setBool/getStringList/setStringList), NOT the settings.set/settings.update
// call pattern — so the settings-key-drift lint does not demand a server-side
// reader for a key that is, by ruling, phone-local and never synced.
//
// A1c (2026-07-31): the 「also sync record-only entries to the PC」 toggle that used to live here
// (`kNotedSyncEnabledKey` / `isNotedSyncEnabled` / `setNotedSyncEnabled`) is
// DELETED, not disabled or left commented-out. Card A1 retired its only
// consumer (the emit-side gate in timeline_sync.dart) under the owner's
// no-cloud-sync ruling (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md);
// with zero readers left, a switch that promises "turn this on and it syncs"
// while doing nothing is the red line's second direction (success theatre).
// The capability may return with window B's persistent outbox — at which point
// "send this noted row to PC" is a delivery decision, not a storage-sync one,
// and deserves a new key rather than this one revived.

import 'package:shared_preferences/shared_preferences.dart';

import '../signaling/wire_payloads.dart' show SendPolicy;

/// R6 T-3a: the send policy (direct-send ⚡ / hold-then-send ➤). DEVICE-LOCAL by
/// the lead's ruling D4 — the phone's own habit, deliberately NOT a synced settings key
/// and deliberately NOT a settings-page section (D4 rejected a 「mode」 section; the
/// entry point is the send button's two states).
const String kSendPolicyKey = 'flowmic.compose.send_policy';

/// R6 T-3b ③: the Favorites list (F-5 Favorites). DEVICE-LOCAL — a quick-send phrase
/// book is the phone's own, it never joins settings sync and never touches the
/// timeline.
///
/// STORAGE CHOICE: F-5's original text says Hive. This repo has no Hive
/// dependency (and CLAUDE.md's reuse-first/lean discipline says do not add one for a
/// ≤50-row string list), and the device-local pref family already lives here
/// through `shared_preferences`. Stored as a StringList in newest-first order —
/// the list IS the recency order, so the ≤50 trim is a tail cut.
const String kFavoritesKey = 'flowmic.compose.favorites';

/// GA-01 ruling 2: the translate target language. DEVICE-LOCAL for the same reason
/// the send policy is — it is this phone's habit, not an account setting, and a
/// synced key would need a server reader it has no use for. `en` is the default
/// because that is what the server's prompt already falls back to (compose/
/// prompt.ts), so an un-set phone and an un-set server agree.
const String kTranslateTargetKey = 'flowmic.pref.translate_target';
const String kTranslateTargetDefault = 'en';

// T-1 (0.2.63): `kPunctGroupExpandedKey` / `punctGroupExpanded` /
// `setPunctGroupExpanded` are DELETED, not left as an unread habit. They
// remembered whether the ComposeBand's punctuation group was open, and owner
// 2026-08-13 Q2㋐ deleted that group outright — a preference whose only reader
// is gone is the same shape as `kNotedSyncEnabledKey` above, and it goes the
// same way. Stored values on existing phones are simply never read again; the
// key is device-local and was never synced, so nothing on any server knows it
// existed.

/// The pair the chip offers in 0.1.0. Not a closed set on the wire — the server
/// takes any language tag — but the chip does not invent a language picker for
/// a private-domain build with one owner.
const List<String> kTranslateTargets = <String>['en', 'zh'];

abstract class LocalPrefs {
  /// 08 §5: direct-send is the DEFAULT; manual is the opt-in habit.
  Future<SendPolicy> sendPolicy();
  Future<void> setSendPolicy(SendPolicy policy);

  /// F-5 Favorites, newest-first. Empty when never used.
  Future<List<String>> favorites();
  Future<void> setFavorites(List<String> favorites);

  /// GA-01: the translate target language tag. Defaults to
  /// [kTranslateTargetDefault] when never chosen.
  Future<String> translateTarget();
  Future<void> setTranslateTarget(String lang);
}

/// Parse a stored wire name back to the enum. Anything unrecognised (or absent)
/// falls back to the documented default rather than guessing.
SendPolicy sendPolicyFromWire(Object? raw) =>
    raw == SendPolicy.manual.name ? SendPolicy.manual : SendPolicy.direct;

class InMemoryLocalPrefs implements LocalPrefs {
  InMemoryLocalPrefs({
    SendPolicy sendPolicy = SendPolicy.direct,
    List<String> favorites = const <String>[],
    String translateTarget = kTranslateTargetDefault,
  }) : _sendPolicy = sendPolicy,
       _favorites = List<String>.of(favorites),
       _translateTarget = translateTarget;
  SendPolicy _sendPolicy;
  List<String> _favorites;
  String _translateTarget;

  @override
  Future<SendPolicy> sendPolicy() async => _sendPolicy;

  @override
  Future<void> setSendPolicy(SendPolicy policy) async => _sendPolicy = policy;

  @override
  Future<List<String>> favorites() async => List<String>.of(_favorites);

  @override
  Future<void> setFavorites(List<String> favorites) async =>
      _favorites = List<String>.of(favorites);

  @override
  Future<String> translateTarget() async => _translateTarget;

  @override
  Future<void> setTranslateTarget(String lang) async =>
      _translateTarget = lang;
}

class SharedPrefsLocalPrefs implements LocalPrefs {
  SharedPrefsLocalPrefs(this._prefs);
  final SharedPreferences _prefs;

  @override
  Future<SendPolicy> sendPolicy() async =>
      sendPolicyFromWire(_prefs.getString(kSendPolicyKey));

  @override
  Future<void> setSendPolicy(SendPolicy policy) async {
    await _prefs.setString(kSendPolicyKey, policy.name);
  }

  @override
  Future<List<String>> favorites() async =>
      _prefs.getStringList(kFavoritesKey) ?? const <String>[];

  @override
  Future<void> setFavorites(List<String> favorites) async {
    await _prefs.setStringList(kFavoritesKey, favorites);
  }

  @override
  Future<String> translateTarget() async {
    final String? stored = _prefs.getString(kTranslateTargetKey);
    // An empty / absent value is the documented default, never a blank tag
    // that would make the server guess.
    return (stored == null || stored.isEmpty)
        ? kTranslateTargetDefault
        : stored;
  }

  @override
  Future<void> setTranslateTarget(String lang) async {
    await _prefs.setString(kTranslateTargetKey, lang);
  }
}
