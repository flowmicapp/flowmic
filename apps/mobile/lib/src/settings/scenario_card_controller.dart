// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (structured scenario
//     card written to `scenario.card`); CLAUDE.md red line (settings apply
//     and persist immediately, no save button)
//   packages/protocol/src/scenario.ts + generated FlowMicSettingsKeys.scenarioCard
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md (Q6/Q7:
//     the card lives ONLY on this phone; each phone has its own) and the same
//     day's follow-up ruling 2 item 2: the carrier is the transcription request
//     itself.
//
// Owns the live ScenarioCard for the settings screen. Every mutation is
// apply-and-save-immediately: it (1) applies the capped transform and (2)
// persists to the device-local store — no save button, no staging.
//
// ── 🔴 THE WIRE HALF IS GONE, AND THAT IS THE DESIGN ──────────────────
// The device-local store is THE copy. The card reaches a server only by riding
// the request that starts a transcription cycle: `settings/
// phone_prefs_payload.dart` reads [card] at the moment `audio:start` /
// `compose:start` is built. So there is no push to make, no admission edge to
// re-push on, and nothing that can be owed — which is why `_onRoomJoined`,
// `syncPending` and the 「saved locally · pending sync」 note left this file on
// 2026-09-03 (WP-B2) along with the `settings:update` that used to carry the
// card. The server REFUSES that write now, for every client.
//
// ── WHAT LEFT EARLIER THE SAME DAY (WP-B) ────────────────────────
// GA-11's read half — adopting the server's copy from settings:list /
// settings:updated, the five conflict rules, the `updated_at` stamp and the
// 「updated from your PC」 note — went with the server copy itself. A cache
// written by the stamped era (an envelope with `updated_at`) still loads; the
// stamp is simply ignored.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'scenario_card.dart';

/// Device-local persistence for the scenario card — THE copy (not a cache of a
/// server row any more). Not the settings-store call pattern, so the
/// settings-key-drift lint is unaffected.
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

  /// The device-local prefs key (distinct from the SERVER settings key
  /// FlowMicSettingsKeys.scenarioCard) — this string never travels the wire.
  /// Public so the settings backup (portable/settings_backup.dart) reads and
  /// writes the SAME key through this class rather than spelling it twice.
  static const String cacheKey = 'flowmic.scenario.card.cache';

  /// 🔴 TWO payload shapes live under ONE prefs key, on purpose.
  ///
  /// Before stamps, this key held `ScenarioCard.toJson()` directly. The stamped
  /// era (2026-08-16 → 2026-09-03) wrote an ENVELOPE `{"card": {...},
  /// "updated_at": "..."}`. Migrating by key rename would silently blank the
  /// card of every user who upgrades (the new key is empty on first read), so
  /// the shape is discriminated instead: a payload carrying any of the four card
  /// arrays AT TOP LEVEL is the bare form, anything else is an envelope whose
  /// `card` is read and whose stamp (if any) is ignored. Saves are bare again.
  static const List<String> _cardFields = <String>[
    'professions',
    'domains',
    'packs',
    'terms',
  ];

  @override
  Future<ScenarioCard> load() async {
    final String? raw = _prefs.getString(cacheKey);
    if (raw == null || raw.isEmpty) return ScenarioCard.empty;
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) return ScenarioCard.empty;
      if (_cardFields.any(decoded.containsKey)) {
        return ScenarioCard.fromJson(decoded);
      }
      return ScenarioCard.fromJson(decoded['card']);
    } on FormatException {
      return ScenarioCard.empty; // corrupt store degrades, never throws
    }
  }

  @override
  Future<void> save(ScenarioCard card) async {
    await _prefs.setString(cacheKey, jsonEncode(card.toJson()));
  }
}

class ScenarioCardController extends ChangeNotifier {
  ScenarioCardController({required ScenarioCardCache cache}) : _cache = cache;

  final ScenarioCardCache _cache;

  ScenarioCard _card = ScenarioCard.empty;

  /// The card, read by the settings screen AND by
  /// `settings/phone_prefs_payload.dart` at every `audio:start` /
  /// `compose:start`. That second reader IS the delivery mechanism — grep it
  /// before believing an edit reaches a server.
  ScenarioCard get card => _card;

  /// Hydrate from the local store on boot, folding any pre-2026-09-04 card
  /// onto the taxonomy's stable ids.
  ///
  /// 🔴 ONE-TIME MIGRATION, WRITTEN BACK IMMEDIATELY — the same pattern (and
  /// the same reason) as the desktop settings client's retired-key prune. A
  /// build that only migrated ON THE WAY OUT would leave the mixed-language
  /// labels sitting in storage: the settings BACKUP reads that store directly
  /// (portable/settings_backup.dart), so an export taken before the user's
  /// first chip edit would carry the old duplicates straight back into the
  /// next phone. The write happens only when the migration actually changed
  /// something, so a card that is already ids does not get a pointless write
  /// on every boot.
  Future<void> load() async {
    final ScenarioCard stored = await _cache.load();
    final ScenarioCard migrated = stored.migratedToIds();
    _card = migrated;
    if (migrated != stored) await _cache.save(migrated);
    notifyListeners();
  }

  void toggleProfession(String value) => _commit(_card.toggleProfession(value));
  void toggleDomain(String value) => _commit(_card.toggleDomain(value));
  void togglePack(String id) => _commit(_card.togglePack(id));
  void removeTerm(String term) => _commit(_card.removeTerm(term));

  /// Add a custom term (with optional aliases); returns the outcome so the view
  /// can flash a reason on a rejected add (too long / duplicate / at cap / a
  /// bad alias). A successful add is apply-and-save-immediately.
  TermAddOutcome addTerm(String raw, {List<String> aliases = const <String>[]}) {
    final TermAddResult r = _card.addTerm(raw, aliases: aliases);
    if (r.outcome == TermAddOutcome.added) _commit(r.card);
    return r.outcome;
  }

  /// Replace the whole card — the settings restore path
  /// (portable/settings_backup.dart) after it wrote the store, and nothing
  /// else. A restored card needs no announcement: the next utterance reads it.
  void adopt(ScenarioCard next) => _commit(next);

  void _commit(ScenarioCard next) {
    if (next == _card) return; // no-op transform (e.g. at-cap toggle) => no write
    _card = next;
    // Fire-and-forget local persist; the in-memory card is already updated so
    // the UI is consistent even before the write settles.
    unawaited(_cache.save(next));
    notifyListeners();
  }
}
