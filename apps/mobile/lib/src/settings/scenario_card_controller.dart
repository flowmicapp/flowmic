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

/// A cached card AND the moment it was last edited — one type, because the two
/// halves are only useful together. A card whose stamp was dropped somewhere in
/// the pipeline cannot be arbitrated at all, and the shape that made that easy
/// to do accidentally was two return values.
///
/// [updatedAt] is null for UNKNOWN and is never defaulted: a legacy cache
/// written before stamps existed, or a value adopted from a server that did not
/// say. See the precedence rules on [ScenarioCardController._onRemoteEntry] —
/// unknown means "abstain", which degrades to the pre-stamp behaviour.
@immutable
class CachedScenarioCard {
  const CachedScenarioCard(this.card, this.updatedAt);
  final ScenarioCard card;
  final String? updatedAt;

  static const CachedScenarioCard empty =
      CachedScenarioCard(ScenarioCard.empty, null);
}

/// Device-local persistence for the last-known scenario card (a CACHE of the
/// server-authoritative setting — not the settings-store call pattern, so the
/// settings-key-drift lint is unaffected).
abstract class ScenarioCardCache {
  Future<CachedScenarioCard> load();
  Future<void> save(CachedScenarioCard entry);
}

class InMemoryScenarioCardCache implements ScenarioCardCache {
  InMemoryScenarioCardCache([this._entry = CachedScenarioCard.empty]);
  CachedScenarioCard _entry;
  @override
  Future<CachedScenarioCard> load() async => _entry;
  @override
  Future<void> save(CachedScenarioCard entry) async => _entry = entry;
}

class SharedPrefsScenarioCardCache implements ScenarioCardCache {
  SharedPrefsScenarioCardCache(this._prefs);
  final SharedPreferences _prefs;

  // A device-local cache key (distinct from the SERVER settings key
  // FlowMicSettingsKeys.scenarioCard) — this string never travels the wire.
  static const String _cacheKey = 'flowmic.scenario.card.cache';

  /// 🔴 TWO payload shapes live under ONE prefs key, on purpose.
  ///
  /// Before stamps, this key held `ScenarioCard.toJson()` directly. It now holds
  /// an ENVELOPE `{"card": {...}, "updated_at": "..."}`. Migrating by key rename
  /// would silently blank the card of every user who upgrades (the new key is
  /// empty on first read), so the shape is discriminated instead: a payload
  /// carrying any of the four card arrays AT TOP LEVEL is the legacy form, and
  /// it loads as a card with NO stamp — which is the truth, because nothing ever
  /// recorded when it was written. The very next local edit rewrites it as an
  /// envelope.
  static const List<String> _legacyCardFields = <String>[
    'professions',
    'domains',
    'packs',
    'terms',
  ];

  @override
  Future<CachedScenarioCard> load() async {
    final String? raw = _prefs.getString(_cacheKey);
    if (raw == null || raw.isEmpty) return CachedScenarioCard.empty;
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) return CachedScenarioCard.empty;
      if (_legacyCardFields.any(decoded.containsKey)) {
        return CachedScenarioCard(ScenarioCard.fromJson(decoded), null);
      }
      final Object? stamp = decoded['updated_at'];
      return CachedScenarioCard(
        ScenarioCard.fromJson(decoded['card']),
        stamp is String && stamp.isNotEmpty ? stamp : null,
      );
    } on FormatException {
      return CachedScenarioCard.empty; // corrupt cache degrades, never throws
    }
  }

  @override
  Future<void> save(CachedScenarioCard entry) async {
    await _prefs.setString(
      _cacheKey,
      jsonEncode(<String, Object?>{
        'card': entry.card.toJson(),
        if (entry.updatedAt != null) 'updated_at': entry.updatedAt,
      }),
    );
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
    // 🔴 THE ABSENT-ROW HALF, which no timestamp can fix. `scenario.card` is
    // NOT seeded (apps/server-core/src/settings/defaults.ts seeds only
    // stt.routings + llm.config), so on a server this phone has never written
    // the row does not exist and settings:list simply omits the key — nothing
    // arrives to arbitrate against, while the correction pipeline runs against
    // EMPTY_CARD and nobody is told. Arbitrating on receipt therefore converges
    // one direction only; the phone has to PUSH what it holds when it is
    // admitted. The edge is the settings client's own (its [roomJoins]
    // pass-through) so this stays one answer to "when may settings talk", and
    // the server's regress guard is what makes pushing safe against a newer
    // desktop edit.
    _settings.roomJoins.addListener(_onRoomJoined);
  }

  final SettingsClient _settings;
  final ScenarioCardCache _cache;
  StreamSubscription<SettingsEntry>? _remoteSub;

  ScenarioCard _card = ScenarioCard.empty;
  ScenarioCard get card => _card;

  /// When [_card] was last written, ISO-8601 UTC — by us in [_commit], or by
  /// whoever the adopted server value came from. Null is UNKNOWN and is never
  /// defaulted to a real instant: see [CachedScenarioCard.updatedAt].
  String? _cardUpdatedAt;

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

  /// Server value for one key. Conflict rules, IN THIS ORDER:
  ///  1. not our key            → ignore entirely (no spurious rebuild);
  ///  2. identical to the card  → nothing happened, say nothing;
  ///  3. an edit of ours is still un-synced → OUR edit is the later write and is
  ///     already queued to re-flush, so it wins and the snapshot is dropped. The
  ///     「saved locally · pending sync when back online」 note is on screen
  ///     throughout, so the user is not
  ///     silently told a story about which value will win;
  ///  4. 🔴 BOTH stamps known AND the incoming one is strictly OLDER → this is a
  ///     stale snapshot (typically this account's OTHER server, which never saw
  ///     the edit we made on the first one). Do not adopt, and do not merely
  ///     drop it either: re-push our card WITH ITS STAMP, because the reason
  ///     that server is stale is that nobody has told it. Dropping silently is
  ///     what left the two channels permanently divergent;
  ///  5. otherwise → the server value is the later write, or one of the two
  ///     stamps is unknown: adopt it, persist it to the local cache, and flag
  ///     [remoteRefreshed] if it displaced something visible.
  ///
  /// 🔴 RULE 5 IS WHAT MAKES THIS SAFE TO SHIP IN ANY ORDER. Every absent-stamp
  /// case — an older relay that strips `updated_at`, a synthesised row, a legacy
  /// local cache — lands there, and rule 5 is byte-for-byte the behaviour this
  /// method had before stamps existed. The new arbitration can only engage when
  /// BOTH sides supplied a real instant.
  void _onRemoteEntry(SettingsEntry e) {
    if (e.key != FlowMicSettingsKeys.scenarioCard) return; // 1
    final ScenarioCard incoming = ScenarioCard.fromJson(e.value);
    if (incoming == _card) return; // 2
    if (syncPending) return; // 3
    if (_incomingIsStale(e.updatedAt)) {
      // 4 — tell the stale side what it is missing. `_cardUpdatedAt` is
      // non-null here (that is half of what _incomingIsStale checked), so this
      // push carries a stamp and the server can arbitrate it rather than
      // taking our word for it.
      _settings.pushScenarioCard(_card.toJson(), updatedAt: _cardUpdatedAt);
      return;
    }
    final bool displacedVisible = !_card.isEmpty; // 5
    _card = incoming;
    _cardUpdatedAt = e.updatedAt;
    unawaited(_cache.save(CachedScenarioCard(incoming, e.updatedAt)));
    if (displacedVisible) _remoteRefreshed = true;
    notifyListeners();
  }

  /// True only when BOTH stamps parse as instants and theirs is strictly older.
  ///
  /// ⚠️ Parsed, never string-compared. These arrive over a wire whose `Iso8601`
  /// is `z.string().min(1)` — a name, not a validator — so a junk stamp does
  /// cross the boundary, and lexical ordering would rank 'yesterday' above
  /// '2026-…' and let garbage win every comparison. Unparseable is UNKNOWN,
  /// which routes to rule 5 (adopt), exactly like absent.
  bool _incomingIsStale(String? incomingAt) {
    final String? ours = _cardUpdatedAt;
    if (incomingAt == null || ours == null) return false;
    final DateTime? theirs = DateTime.tryParse(incomingAt);
    final DateTime? mine = DateTime.tryParse(ours);
    if (theirs == null || mine == null) return false;
    return theirs.isBefore(mine);
  }

  /// The server admitted us. Push what this device holds, so a server that has
  /// NO row for this key learns about it — see the constructor's note on the
  /// absent-row half.
  ///
  /// An empty card is not pushed: "I have nothing" is not a fact worth
  /// overwriting someone else's card with, and on a fresh install it is also
  /// the answer we are about to receive from settings:list anyway.
  void _onRoomJoined() {
    if (_card.isEmpty) return;
    _settings.pushScenarioCard(_card.toJson(), updatedAt: _cardUpdatedAt);
  }

  /// Hydrate from the local cache on boot. Does NOT push (loading is not an
  /// edit); the server already holds the authoritative copy — and if it does
  /// not, [_onRoomJoined] is the place that says so.
  Future<void> load() async {
    final CachedScenarioCard cached = await _cache.load();
    _card = cached.card;
    _cardUpdatedAt = cached.updatedAt;
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
    // THE stamp is minted here and nowhere else: this is the one moment in the
    // app at which a human actually changed this card, which is the only thing
    // `updated_at` is allowed to mean. UTC because the server parses it and two
    // devices in two zones must be comparable.
    //
    // 🔴 C3 — it comes from the settings client rather than from
    // `DateTime.now()` directly, and that is not indirection for its own sake.
    // The stamp is only ever compared against a stamp authored on ANOTHER
    // machine, so a phone whose clock lags stamps this genuinely newer edit into
    // the server's past: the write is refused, the stored card is pushed back,
    // rule 5 below adopts it, and the terms the user just typed vanish with
    // nothing said. The client corrects for the lag it has measured from the
    // stamps it has seen — see settings_stamp_clock.dart.
    final String stamp = _settings.nowStamp();
    _cardUpdatedAt = stamp;
    // A local edit supersedes whatever the last remote refresh said, so the
    // note about it stops being true here.
    _remoteRefreshed = false;
    // Fire-and-forget local persist; the in-memory card is already updated so
    // the UI is consistent even before the write settles.
    unawaited(_cache.save(CachedScenarioCard(next, stamp)));
    // The literal-key SET anchor. Local cache above already holds the edit, so
    // an offline push degrades to a pending re-sync (surfaced via [syncPending]),
    // never a silent loss.
    _settings.pushScenarioCard(next.toJson(), updatedAt: stamp);
    notifyListeners();
  }

  @override
  void dispose() {
    _settings.pendingSync.removeListener(_onPendingChanged);
    _settings.roomJoins.removeListener(_onRoomJoined);
    unawaited(_remoteSub?.cancel());
    super.dispose();
  }
}
