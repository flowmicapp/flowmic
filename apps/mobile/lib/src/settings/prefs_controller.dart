// SPEC-REF:
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
//     (Q2 b: two-pass refine is a phone switch; Q3 a: the scenario-inference
//     consent is the user's, so it lives on the phone; Q6 note: none of these
//     is stored by any server) and the same day's follow-up ruling 2 item 2:
//     the phone puts these parameters INSIDE the request that starts a
//     transcription cycle.
//   docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md
//     D1 (corrected: the carrier is the request, not settings:update),
//     D3 (the key set), D8 (consent semantics on a phone that cannot see the
//     PC's endpoint)
//   packages/protocol/src/stt-polish.ts (SttPolishSchema {enabled, strength?},
//     POLISH_STRENGTHS = strict | smooth), packages/protocol/src/stt-refine.ts
//     (SttRefineSchema {enabled}), packages/protocol/src/scenario-consent.ts
//     (ScenarioConsentRow {granted, granted_for})
//
// The three phone-owned preferences beside the scenario card: AI polish (switch
// + strength), two-pass refine (switch) and the scenario-inference consent
// (switch). Two moves per edit — apply, persist locally. There is no third
// move: `settings/phone_prefs_payload.dart` reads [prefs] when `audio:start` /
// `compose:start` is built, and that is the whole delivery mechanism. The push
// half (`settings:update` on every edit and on every admission), `syncPending`
// and the 「saved locally · pending sync」 note left this file on 2026-09-03
// (WP-B2); the server refuses those writes now, from any client.
//
// ── 🔴 「NEVER SET」 IS A REAL STATE, AND IT IS NOT CARRIED ────────────────
// A preference the user has never touched is `null` here and is absent from the
// bundle. The server then reads 「not set」 and applies ITS default — for polish
// that default is 「on when this deployment can resolve a language model, off
// when it cannot」 (stt-polish-settings.ts), a decision the server can make and
// this phone cannot. Carrying a guessed value would turn 「the PC has no model」
// into a polish attempt that fails on every sentence and a notice on every row.
// So the UI renders the product default for an untouched switch (polish on ·
// strict; refine off; consent off), the first tap makes it explicit, and only
// explicit values travel.
//
// ── D8: WHAT THE CONSENT SWITCH MEANS ON A PHONE ───────────────────────────
// The consent row records the DESTINATION the user was shown (`granted_for`:
// local | external) so a later endpoint change can widen the exposure and be
// caught (scenario-consent.ts `inferenceBlockedReason`). This phone cannot see
// the PC's model endpoint, so the only honest thing it can ask is the widest
// one: 「allow my computer to hand the foreground app's name to whatever model
// service it is using」. That is `granted_for: 'external'` — the value that
// covers every destination, so the server's widening guard never blocks a
// consent given here, and the copy on the switch says exactly that
// (AppStrings.inferenceSub). The server's own 「endpoint not provable ⇒ do not
// infer」 rail stays where it is; this row only answers the user's half.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// How far AI polish may go. Wire names are the protocol's POLISH_STRENGTHS
/// (`strict` | `smooth`) — `name` IS the wire value, pinned by a test.
enum PolishStrength { strict, smooth }

PolishStrength? polishStrengthFromWire(Object? raw) => switch (raw) {
  'strict' => PolishStrength.strict,
  'smooth' => PolishStrength.smooth,
  _ => null,
};

/// `stt.polish` as this phone holds it. [strength] is never null here: the
/// protocol reads an absent strength as `strict` at its boundary, and the
/// phone writes the value it shows rather than leaning on that default.
@immutable
class PolishPrefs {
  const PolishPrefs({required this.enabled, this.strength = PolishStrength.strict});
  final bool enabled;
  final PolishStrength strength;

  /// Exactly SttPolishSchema (which is `.strict()` — no extra keys).
  Map<String, Object?> toJson() =>
      <String, Object?>{'enabled': enabled, 'strength': strength.name};

  static PolishPrefs? tryFromJson(Object? json) {
    if (json is! Map) return null;
    final Object? enabled = json['enabled'];
    if (enabled is! bool) return null;
    return PolishPrefs(
      enabled: enabled,
      strength: polishStrengthFromWire(json['strength']) ?? PolishStrength.strict,
    );
  }

  PolishPrefs copyWith({bool? enabled, PolishStrength? strength}) =>
      PolishPrefs(enabled: enabled ?? this.enabled, strength: strength ?? this.strength);

  @override
  bool operator ==(Object other) =>
      other is PolishPrefs && enabled == other.enabled && strength == other.strength;
  @override
  int get hashCode => Object.hash(enabled, strength);
}

/// `stt.refine` as this phone holds it. Only the switch: the utterance floor
/// stays the server's clamped default (stt-refine.ts) — a number the user
/// never sees has no business in a settings row.
@immutable
class RefinePrefs {
  const RefinePrefs({required this.enabled});
  final bool enabled;

  Map<String, Object?> toJson() => <String, Object?>{'enabled': enabled};

  static RefinePrefs? tryFromJson(Object? json) {
    if (json is! Map) return null;
    final Object? enabled = json['enabled'];
    return enabled is bool ? RefinePrefs(enabled: enabled) : null;
  }

  @override
  bool operator ==(Object other) => other is RefinePrefs && enabled == other.enabled;
  @override
  int get hashCode => enabled.hashCode;
}

/// `scenario.inference` as this phone holds it — see the D8 note in the header
/// for why the stored destination is always the widest one.
@immutable
class InferenceConsentPrefs {
  const InferenceConsentPrefs({required this.granted});
  final bool granted;

  /// The wire value every reader accepts. `granted_for` is spelled here ONCE.
  static const String grantedFor = 'external';

  /// Exactly ScenarioConsentRow.
  Map<String, Object?> toJson() =>
      <String, Object?>{'granted': granted, 'granted_for': grantedFor};

  static InferenceConsentPrefs? tryFromJson(Object? json) {
    if (json is! Map) return null;
    final Object? granted = json['granted'];
    return granted is bool ? InferenceConsentPrefs(granted: granted) : null;
  }

  @override
  bool operator ==(Object other) =>
      other is InferenceConsentPrefs && granted == other.granted;
  @override
  int get hashCode => granted.hashCode;
}

/// The three rows together, each nullable = never set (header).
@immutable
class PhonePrefs {
  const PhonePrefs({this.polish, this.refine, this.inference});
  final PolishPrefs? polish;
  final RefinePrefs? refine;
  final InferenceConsentPrefs? inference;

  static const PhonePrefs empty = PhonePrefs();

  PhonePrefs copyWith({
    PolishPrefs? polish,
    RefinePrefs? refine,
    InferenceConsentPrefs? inference,
  }) => PhonePrefs(
    polish: polish ?? this.polish,
    refine: refine ?? this.refine,
    inference: inference ?? this.inference,
  );
}

/// Device-local persistence for [PhonePrefs] — THE copy.
abstract class PrefsStore {
  Future<PhonePrefs> load();
  Future<void> save(PhonePrefs prefs);
}

class InMemoryPrefsStore implements PrefsStore {
  InMemoryPrefsStore([this._prefs = PhonePrefs.empty]);
  PhonePrefs _prefs;
  @override
  Future<PhonePrefs> load() async => _prefs;
  @override
  Future<void> save(PhonePrefs prefs) async => _prefs = prefs;
}

class SharedPrefsPrefsStore implements PrefsStore {
  SharedPrefsPrefsStore(this._prefs);
  final SharedPreferences _prefs;

  /// Device-local keys (never the wire). Each holds the row's JSON, in exactly
  /// the shape the wire carries, so the settings backup can copy them through
  /// without a second encoding. Public for the backup, which reads and writes
  /// these SAME keys through this class.
  static const String polishKey = 'flowmic.prefs.polish';
  static const String refineKey = 'flowmic.prefs.refine';
  static const String inferenceKey = 'flowmic.prefs.inference_consent';

  static Object? _decode(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      return jsonDecode(raw);
    } on FormatException {
      return null; // a corrupt row reads as never set, never throws
    }
  }

  @override
  Future<PhonePrefs> load() async => PhonePrefs(
    polish: PolishPrefs.tryFromJson(_decode(_prefs.getString(polishKey))),
    refine: RefinePrefs.tryFromJson(_decode(_prefs.getString(refineKey))),
    inference: InferenceConsentPrefs.tryFromJson(_decode(_prefs.getString(inferenceKey))),
  );

  @override
  Future<void> save(PhonePrefs prefs) async {
    await _put(polishKey, prefs.polish?.toJson());
    await _put(refineKey, prefs.refine?.toJson());
    await _put(inferenceKey, prefs.inference?.toJson());
  }

  Future<void> _put(String key, Map<String, Object?>? value) async {
    if (value == null) {
      await _prefs.remove(key);
    } else {
      await _prefs.setString(key, jsonEncode(value));
    }
  }
}

class PrefsController extends ChangeNotifier {
  PrefsController({required PrefsStore store}) : _store = store;

  final PrefsStore _store;

  PhonePrefs _prefs = PhonePrefs.empty;

  /// The rows as held (null = never set). Read by the settings screen, by the
  /// backup, and — at every `audio:start` / `compose:start` — by
  /// `settings/phone_prefs_payload.dart`, which is the ONLY thing that puts
  /// them on a wire.
  PhonePrefs get prefs => _prefs;

  /// What the switches SHOW. The product default for an untouched row (header).
  bool get polishEnabled => _prefs.polish?.enabled ?? true;
  PolishStrength get polishStrength => _prefs.polish?.strength ?? PolishStrength.strict;
  bool get refineEnabled => _prefs.refine?.enabled ?? false;
  bool get inferenceGranted => _prefs.inference?.granted ?? false;

  /// Hydrate from the local store on boot.
  Future<void> load() async {
    _prefs = await _store.load();
    notifyListeners();
  }

  void setPolishEnabled(bool enabled) {
    final PolishPrefs next =
        (_prefs.polish ?? PolishPrefs(enabled: polishEnabled, strength: polishStrength))
            .copyWith(enabled: enabled);
    if (next == _prefs.polish) return;
    _prefs = _prefs.copyWith(polish: next);
    _commit();
  }

  void setPolishStrength(PolishStrength strength) {
    final PolishPrefs next =
        (_prefs.polish ?? PolishPrefs(enabled: polishEnabled, strength: polishStrength))
            .copyWith(strength: strength);
    if (next == _prefs.polish) return;
    _prefs = _prefs.copyWith(polish: next);
    _commit();
  }

  void setRefineEnabled(bool enabled) {
    final RefinePrefs next = RefinePrefs(enabled: enabled);
    if (next == _prefs.refine) return;
    _prefs = _prefs.copyWith(refine: next);
    _commit();
  }

  void setInferenceGranted(bool granted) {
    final InferenceConsentPrefs next = InferenceConsentPrefs(granted: granted);
    if (next == _prefs.inference) return;
    _prefs = _prefs.copyWith(inference: next);
    _commit();
  }

  /// Replace all three rows — the settings restore path
  /// (portable/settings_backup.dart) after it wrote the store, and nothing
  /// else. Nothing is announced: the next utterance carries whatever is here.
  void adopt(PhonePrefs next) {
    _prefs = next;
    unawaited(_store.save(next));
    notifyListeners();
  }

  void _commit() {
    unawaited(_store.save(_prefs));
    notifyListeners();
  }
}
