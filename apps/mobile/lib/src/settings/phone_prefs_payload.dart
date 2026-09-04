// SPEC-REF:
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
//     追加裁定二 ②:「手机发起一次转录周期时，向服务器的请求里要把客户端的这些参数
//     一起带过去」 — the phone carries its parameters INSIDE the request that
//     starts a transcription cycle.
//   docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md D1
//     (corrected: the carrier is the request itself, not `settings:update`)
//   packages/protocol/src/phone-prefs.ts (PhonePrefsSchema — the four optional
//     dotted keys, each validated with the schema its settings key always had)
//   docs/decisions/2026-07-23-settings-key-drift-literal-anchors.md
//
// ── THE BUNDLE, AND WHY IT IS BUILT IN ONE PLACE ────────────────────────────
//
// `audio:start` and `compose:start` both carry an optional `prefs` object. The
// server reads it for exactly that session and forgets it; nothing is stored,
// there is no `settings:update` for these keys any more (the server refuses one
// — SETTINGS_SCHEMA_INVALID), and a key absent from a bundle means UNSET, never
// 「keep the previous one」. So the two frames must say the SAME thing about this
// phone or the same sentence would be polished one way when it is spoken and
// another way when it is organised — one value with two answers, this repo's
// number-one bug shape. One builder, read at emit time, is what makes that
// structurally impossible rather than a discipline.
//
// ── 🔴 「NEVER SET」 IS A REAL STATE AND IS OMITTED ──────────────────────────
//
// A preference the user has never touched is absent from the bundle. The server
// then reads 「not set」 and applies ITS default — for polish that is 「on when
// this deployment can resolve a language model, off when it cannot」, a decision
// the server can make and this phone cannot. Same rule the push-era controllers
// used, for the same reason; it is also what keeps a fresh install's frames
// byte-for-byte what they were before this card (the `prefs` key is omitted
// entirely when the bundle is empty — see [PhonePrefsCarrier.frame]).
//
// ── LITERAL-KEY SET ANCHORS (verify/lint/settings-key-drift.mjs) ────────────
//
// The four `carrySetting('<dotted key>', …)` calls below are the ONLY places in
// apps/mobile that name these keys as string literals, and they are the SET
// half the lint pairs with the server's `readSetting('<same key>')` GET half.
// They moved here from `settings_client.dart`'s `push*` methods when the carrier
// changed: the lint's question is 「does anything on this end actually put this
// key on the wire」, and after this card the answer is this file. Each literal is
// pinned == its generated `FlowMicSettingsKeys` constant by
// test/phone_prefs_payload_test.dart, which is what keeps 「the string the lint
// matches」 and 「the string the server reads」 one value.

import '../../generated/flowmic_settings.g.dart';
import 'prefs_controller.dart';
import 'scenario_card.dart';
import 'scenario_card_controller.dart';

/// How a frame builder asks 「what does this phone hold right now?」. Returns
/// null when it holds nothing explicit, which is how `prefs` is OMITTED rather
/// than sent empty.
typedef PhonePrefsSource = Map<String, Object?>? Function();

/// The bundle under construction. `carrySetting` is a real function rather than
/// a bare `map[key] = value` so the drift lint has a call shape to match (see
/// the header) and so 「a null value is an unset key」 has exactly one
/// implementation.
class PhonePrefsBundle {
  final Map<String, Object?> map = <String, Object?>{};

  /// Put [value] on the wire under [key] — unless it is null, which is the
  /// encoding of 「the user never set this」.
  void carrySetting(String key, Object? value) {
    if (value == null) return;
    map[key] = value;
  }
}

/// Reads the two phone-owned preference holders and produces the `prefs` object
/// that rides `audio:start` / `compose:start`.
///
/// It holds the controllers rather than a snapshot: the bundle is built at EMIT
/// time, so a switch flipped between two utterances is already true for the
/// second one without a reconnect, and there is no cached copy that could go
/// stale (the push era's whole failure mode).
class PhonePrefsCarrier {
  const PhonePrefsCarrier({required this.scenario, required this.prefs});

  final ScenarioCardController scenario;
  final PrefsController prefs;

  /// Every key this phone has an explicit value for. May be empty.
  Map<String, Object?> bundle() {
    final PhonePrefsBundle b = PhonePrefsBundle();
    final ScenarioCard card = scenario.card;
    // An empty card is not carried: the server's reader runs against its own
    // empty card, so the two are byte-for-byte the same outcome, and omitting
    // keeps 「an old phone that carries nothing」 and 「a new phone with nothing
    // to say」 indistinguishable — the safe direction (design §2).
    // 🔴 toWireJson, NOT toJson (2026-09-04). The card STORES ids; the server's
    // prompt templates are English and have always read the English names, so
    // this is where the two vocabularies meet. Sending ids here would be a
    // silent regression the protocol could not catch — ScenarioCardSchema takes
    // any non-empty label, so `software-dev` would validate and then read as
    // gibberish inside the prompt. Pinned by phone_prefs_payload_test.dart.
    b.carrySetting('scenario.card', card.isEmpty ? null : card.toWireJson());
    final PhonePrefs held = prefs.prefs;
    b.carrySetting('stt.polish', held.polish?.toJson());
    b.carrySetting('stt.refine', held.refine?.toJson());
    b.carrySetting('scenario.inference', held.inference?.toJson());
    return b.map;
  }

  /// [bundle] as a frame field: null ⇒ the emitter omits `prefs` entirely.
  Map<String, Object?>? frame() {
    final Map<String, Object?> b = bundle();
    return b.isEmpty ? null : b;
  }
}

/// The four dotted keys the bundle may carry, as the generated SSOT constants.
/// Exported for the test that pins each literal above == its constant, and for
/// any consumer that needs to name the set without re-typing it.
const List<String> kPhonePrefsKeys = <String>[
  FlowMicSettingsKeys.scenarioCard,
  FlowMicSettingsKeys.sttPolish,
  FlowMicSettingsKeys.sttRefine,
  FlowMicSettingsKeys.scenarioInference,
];
