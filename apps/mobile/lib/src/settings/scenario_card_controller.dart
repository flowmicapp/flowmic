// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (structured scenario
//     card written to `scenario.card`); CLAUDE.md red line (settings apply
//     and persist immediately, no save button)
//   packages/protocol/src/scenario.ts + generated FlowMicSettingsKeys.scenarioCard
//
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-11 (hydrate from the
//     server snapshot on the connected rising edge; follow settings:updated)
//
// Owns the live ScenarioCard for the settings screen. Every mutation is
// apply-and-save-immediately:
// it (1) applies the capped transform, (2) persists to the device-local cache so
// the card survives an app restart and an offline edit, and (3) best-effort
// pushes settings:update{scenario.card} to the server — no save button, no
// staging. The push key/value are the protocol SSOT constant + the exact
// ScenarioCardSchema JSON, closing the loop to the server's compose reader.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../generated/flowmic_settings.g.dart';
import 'scenario_card.dart';
import 'settings_client.dart';

/// Device-local persistence for the last-known scenario card (a CACHE of the
/// server-authoritative setting — not the settings-store call pattern, so the
/// settings-key-drift lint is unaffected).
abstract class ScenarioCardCache {
  Future<ScenarioCard> load();
  Future<void> save(ScenarioCard card);
}

class InMemoryScenarioCardCache implements ScenarioCardCache {
  InMemoryScenarioCardCache([this._card = ScenarioCard.empty]);
  ScenarioCard _card;
  @override
  Future<ScenarioCard> load() async => _card;
  @override
  Future<void> save(ScenarioCard card) async => _card = card;
}

class SharedPrefsScenarioCardCache implements ScenarioCardCache {
  SharedPrefsScenarioCardCache(this._prefs);
  final SharedPreferences _prefs;

  // A device-local cache key (distinct from the SERVER settings key
  // FlowMicSettingsKeys.scenarioCard) — this string never travels the wire.
  static const String _cacheKey = 'flowmic.scenario.card.cache';

  @override
  Future<ScenarioCard> load() async {
    final String? raw = _prefs.getString(_cacheKey);
    if (raw == null || raw.isEmpty) return ScenarioCard.empty;
    try {
      return ScenarioCard.fromJson(jsonDecode(raw));
    } on FormatException {
      return ScenarioCard.empty; // corrupt cache degrades, never throws
    }
  }

  @override
  Future<void> save(ScenarioCard card) async {
    await _prefs.setString(_cacheKey, jsonEncode(card.toJson()));
  }
}

class ScenarioCardController extends ChangeNotifier {
  ScenarioCardController({
    required SettingsClient settingsClient,
    required ScenarioCardCache cache,
  }) : _settings = settingsClient,
       _cache = cache {
    // Surface the client's pending-sync state so the settings screen can show
    // the SETTINGS_SYNC_FAIL 「saved locally」 note when an edit could not
    // reach the
    // server (offline) and re-hide it once the reconnect flush lands.
    _settings.pendingSync.addListener(_onPendingChanged);
    // GA-11: adopt the server-authoritative card — the connect-time snapshot
    // (settings:list) and every peer push (settings:updated) arrive on this one
    // stream, so a desktop-side edit reaches this screen and a reinstalled phone
    // stops showing a blank card while the server KV still feeds the correction
    // pipeline.
    _remoteSub = _settings.entries.listen(_onRemoteEntry);
  }

  final SettingsClient _settings;
  final ScenarioCardCache _cache;
  StreamSubscription<SettingsEntry>? _remoteSub;

  ScenarioCard _card = ScenarioCard.empty;
  ScenarioCard get card => _card;

  /// True while this card's last edit has not reached the server (queued
  /// offline). Keyed by the SSOT constant — the SAME key the literal SET anchor
  /// pushes — so the fail-loud note and the wire write can never drift apart.
  bool get syncPending =>
      _settings.isKeyPending(FlowMicSettingsKeys.scenarioCard);

  bool _remoteRefreshed = false;

  /// True once a server value REPLACED a non-empty card the user could already
  /// see. The settings screen renders it as a one-line note: an overwrite the
  /// user is not told about is a silent failure, even when the new value is the
  /// correct one. Cleared by the next local edit (that edit is now the truth).
  bool get remoteRefreshed => _remoteRefreshed;

  void _onPendingChanged() => notifyListeners();

  /// Server value for one key. Conflict rule (last-write-wins, told out loud):
  ///  * not our key            → ignore entirely (no spurious rebuild);
  ///  * identical to the card  → nothing happened, say nothing;
  ///  * an edit of ours is still un-synced → OUR edit is the later write and is
  ///    already queued to re-flush, so it wins and the snapshot is dropped. The
  ///    「saved locally · pending sync when back online」 note is on screen
  ///    throughout, so the user is not
  ///    silently told a story about which value will win;
  ///  * otherwise → the server value is the later write: adopt it, persist it to
  ///    the local cache, and flag [remoteRefreshed] if it displaced something
  ///    visible.
  void _onRemoteEntry(SettingsEntry e) {
    if (e.key != FlowMicSettingsKeys.scenarioCard) return;
    final ScenarioCard incoming = ScenarioCard.fromJson(e.value);
    if (incoming == _card) return;
    if (syncPending) return;
    final bool displacedVisible = !_card.isEmpty;
    _card = incoming;
    unawaited(_cache.save(incoming));
    if (displacedVisible) _remoteRefreshed = true;
    notifyListeners();
  }

  /// Hydrate from the local cache on boot. Does NOT push (loading is not an
  /// edit); the server already holds the authoritative copy.
  Future<void> load() async {
    _card = await _cache.load();
    notifyListeners();
  }

  void toggleProfession(String value) => _commit(_card.toggleProfession(value));
  void toggleDomain(String value) => _commit(_card.toggleDomain(value));
  void togglePack(String id) => _commit(_card.togglePack(id));
  void removeTerm(String term) => _commit(_card.removeTerm(term));

  /// Add a custom term; returns the outcome so the view can flash a reason on a
  /// rejected add (too long / duplicate / at cap). A successful add is apply-and-save-immediately.
  TermAddOutcome addTerm(String raw) {
    final TermAddResult r = _card.addTerm(raw);
    if (r.outcome == TermAddOutcome.added) _commit(r.card);
    return r.outcome;
  }

  void _commit(ScenarioCard next) {
    if (next == _card) return; // no-op transform (e.g. at-cap toggle) → no write
    _card = next;
    // A local edit supersedes whatever the last remote refresh said, so the
    // note about it stops being true here.
    _remoteRefreshed = false;
    // Fire-and-forget local persist; the in-memory card is already updated so
    // the UI is consistent even before the write settles.
    unawaited(_cache.save(next));
    // The literal-key SET anchor. Local cache above already holds the edit, so
    // an offline push degrades to a pending re-sync (surfaced via [syncPending]),
    // never a silent loss.
    _settings.pushScenarioCard(next.toJson());
    notifyListeners();
  }

  @override
  void dispose() {
    _settings.pendingSync.removeListener(_onPendingChanged);
    unawaited(_remoteSub?.cancel());
    super.dispose();
  }
}
