// The words a test looks for INSIDE a translated sentence, one table per word,
// for every UI language.
//
// ── why this file exists (2026-08-14, the nine-locale expansion) ─────────────
//
// Four test files each carried their own copy of one of these tables, and two of
// them said so in a comment: pin_mismatch_surface_test.dart wrote 「与
// lan_tls_pin_test.dart 的 `_networkWord` 同源」. That is a comment ASSERTING
// ANOTHER FILE'S BEHAVIOUR — anti-façade ④ — and its truth value changes whenever
// the other file changes, while it does not. At four entries the copies were
// cheap and stayed in step. At nine they are 36 lines duplicated twice, and the
// first time somebody fixes a term in one place the other keeps testing the old
// one and stays green. Now 「同源」 (same origin) is the same SYMBOL rather than a claim.
//
// ── what these tables are, and what they are NOT ────────────────────────────
//
// 🔴 They are NOT translations, and nothing may import them from `lib/`. Each
// entry is 「the word this language's copy MUST (or must NOT) contain for the
// assertion to mean anything」 — a probe, chosen by reading the shipped string.
// The catalogue stays the only source of user-visible text.
//
// 🔴 EXHAUSTIVE SWITCH, NO `_ =>` ARM, DELIBERATELY. A default arm would let
// language number ten compile here and silently probe for an English word
// inside a Norwegian sentence — which fails as a CONTAINS assertion (loud, fine)
// but PASSES as a DOES-NOT-CONTAIN assertion. Half of every pair below is a
// negative assertion, so a default arm would quietly retire the reverse control
// rather than the test. Adding a language must break this file by name.

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flutter_test/flutter_test.dart';

/// "This sentence really is its own translation in every locale, not one locale
/// that forgot to translate and copied another."
///
/// ── what this replaced ────────────────────────────────────────────────────
///
/// Nine tests stuffed the nine-locale translations into a Set, then asserted
/// `hasLength(4)`. **In the four-locale era that sentence meant "pairwise
/// distinct"**, and after `AppLocale.values` grew to 9 it became a sentence
/// nobody meant to say: **"exactly 4 of the nine values are distinct"** —
/// i.e. it **required** five of them to be copies. It went all-red on the
/// spot, and it went red in the wrong direction.
///
/// 🔴 Changing `4` to `AppLocale.values.length` is wrong, and that is
/// **measured** wrong, not inferred: sweeping 678 strings × 9 locales one by
/// one, **legitimate collisions are everywhere** — `zh` and `zhTw` have 43
/// byte-identical strings (simplified/traditional same shape, e.g. 「按住 追加」
/// 「收起」), `en` and `de` share 'Offline' / 'Online' / 'Updates', `en` and
/// `fr` share 'Notes', `fr` and `es` share 'Canal', and 'Enter' / 'Backspace' /
/// 'Free' / 'Pro' / 'FlowMic' are shared by almost everyone. "Nine locales
/// pairwise distinct" **is not a true rule**; writing it as an assertion
/// forces the next person to "fix" a translation that was already correct.
///
/// ── so the criterion is: **allowed collisions must be named** ─────────────
///
/// Each group in [mayShare] is a **named declaration**: "these locales collide
/// on this sentence, and that is correct; the reason is written at the call
/// site". Any collision that is **not named** goes red, and the failure names
/// which locales copied which sentence. ⇒ This is **strictly stronger** than
/// `hasLength(4)`: that only counted, and a correct count still could not say
/// who matched whom; and among 9 values it allowed 5 to be copies.
///
/// ⚠️ [mayShare] is "**may** collide" not "**must** collide": if a locale one
/// day grows its own translation, this must not go red — that is an
/// improvement, not a regression.
///
/// ⚠️ **It does not prove the translation is correct**, only that "it is not
/// the same string". A German sentence machine-translated into nonsense is
/// green here. What actually answers "has it been translated" is
/// `i18n/mobile/coverage.json` (the generator's `inheritsBase`); the two
/// govern different things.
void expectPerLocaleDistinct(
  String Function(AppStrings) pick, {
  required String what,
  List<Set<AppLocale>> mayShare = const <Set<AppLocale>>[],
}) {
  final Map<String, List<AppLocale>> byValue = <String, List<AppLocale>>{};
  for (final AppLocale l in AppLocale.values) {
    byValue.putIfAbsent(pick(AppStrings.of(l)), () => <AppLocale>[]).add(l);
  }
  for (final MapEntry<String, List<AppLocale>> g in byValue.entries) {
    if (g.value.length < 2) continue;
    final Set<AppLocale> collided = g.value.toSet();
    final bool declared = mayShare.any((Set<AppLocale> ok) =>
        collided.length == ok.length && collided.containsAll(ok));
    expect(
      declared,
      isTrue,
      reason: '$what: ${g.value.map((AppLocale l) => l.name).join(' / ')} '
          'produced the same string 「${g.key}」, and this collision was not named. '
          'Either one locale copied another (the i18n kind of failure), '
          'or it is correct and the call site should declare it with mayShare and state why.',
    );
  }
}

/// The local name of the OS 「Accessibility」 permission pane.
///
/// Used by BOTH halves of the 63-vs-64 pair (`inject_verdict_note_test.dart`,
/// `image_verdict_affordance_test.dart`), which is the point: error 64 must name
/// where to grant the permission — it is the one failure on that path a user can
/// fix themselves — and error 63 must NOT send them to a pane that can do
/// nothing for it. owner 2026-08-07 minted two codes precisely because the two
/// actions are opposite.
///
/// ⚠️ Each value is the term the SHIPPED string uses, read out of the catalogue,
/// not a dictionary translation: `de` says 「Bedienungshilfen」 and `ru` says
/// 「Универсальный доступ」 because that is what those platforms call the pane.
/// If a translation is reworded, this table moves with it — that is the table
/// doing its job, not the table being wrong.
String accessibilityTerm(AppLocale locale) => switch (locale) {
  AppLocale.en => 'Accessibility',
  AppLocale.zh => '辅助功能',
  AppLocale.zhTw => '輔助使用',
  AppLocale.fr => 'Accessibilité',
  AppLocale.es => 'Accesibilidad',
  AppLocale.de => 'Bedienungshilfen',
  AppLocale.ja => 'アクセシビリティ',
  AppLocale.ko => '손쉬운 사용',
  AppLocale.ru => 'Универсальный доступ',
};

/// The word that points the user at their NETWORK.
///
/// The "can't-reach" copy keeps it; the "identity mismatch" copy must lose it — the PC answered, so the
/// network is fine and sending the user to look at Wi-Fi is a wrong instruction,
/// not merely a vague one (D2LAN-B3).
///
/// ⚠️ These are matched as plain substrings, so each one was checked against the
/// OTHER sentence before being written down — `es` 'red' and `de` 'Netz' are
/// short enough to collide by accident, and a collision would make the negative
/// half fail for a reason that has nothing to do with the product.
///
/// 🔴 `ru` is the STEM 'сет', not a whole word, and that was MEASURED not
/// guessed. The two callers read two different sentences and Russian declines
/// the noun in each: `pairCandidatesFailed` says 「в одной **сети**」
/// (prepositional) while `pairError(null)` says 「проверьте **сеть**」
/// (accusative). A first cut used 'сети' and it passed the first assertion and
/// failed the second — 「AppLocale.ru：够不着那一档自己丢了「网络」」 — which is the
/// probe being wrong, not the copy. Truncating to the stem covers both and is
/// still specific: grepped against the mismatch copy, the heads and the
/// per-address labels, 'сет' appears in none of them, so the negative half
/// keeps its teeth.
/// (Same hazard, same handling, as `de`/`ru` in `pc_offline_note_test.dart`'s
/// phone-trigger probe. Substring matching does not decline nouns; write the
/// stem or measure both forms.)
String networkWord(AppLocale locale) => switch (locale) {
  AppLocale.en => 'network',
  AppLocale.zh => '网络',
  AppLocale.zhTw => '網路',
  AppLocale.fr => 'réseau',
  AppLocale.es => 'red',
  AppLocale.de => 'Netz',
  AppLocale.ja => 'ネットワーク',
  AppLocale.ko => '네트워크',
  AppLocale.ru => 'сет',
};
