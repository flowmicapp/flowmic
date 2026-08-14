// SPEC-REF:
//   CLAUDE.md red line: settings apply-and-persist immediately, no save
//     button; UI does not follow the OS locale (language is an explicit choice)
//
// Device-local preferences backing the settings screen's IN-SCOPE rows (WP-R3-3):
// the EXPLICIT UI locale mechanism and the theme selector. Persisted via
// shared_preferences (NOT the settings-store call pattern, so invisible to
// settings-key-drift), applied instantly on every change.
//
// The mode / translate-target preferences that a concurrent draft added were
// removed on controller ruling (2026-07-23) as out of scope; a THEME selector
// was likewise removed then as a live façade (picking light mode only
// re-tinted Material chrome — the bespoke FlowMicColors widgets were
// dark-only). V2-07.3 made the palette genuinely switchable and V2-07.4 wires
// the real selector here: the tri-state AppThemeMode persists as
// flowmic.pref.themeMode (default: follow the system) and drives
// FlowMicTheme, the SAME state FlowMicColors resolves through — so the chips
// re-tint the bespoke widgets, not just chrome.
//
// The locale is the EXPLICIT UI language — AppStrings reads THIS, never the OS
// locale (red line). The theme CAN follow the OS (AppThemeMode.system) — the
// two rulings are deliberately different; do not conflate them.
//
// A1c (2026-07-31): this controller used to also mirror the "record-only
// entries also sync to the PC" toggle for the settings-page switch (which
// needed a `LocalPrefs` dep purely to read/write that one flag). That toggle
// is DELETED (not disabled) —
// card A1 retired its only reader (TimelineSyncGate's emit-side gate) under the
// owner's no-cloud-sync ruling, which left the toggle changing nothing while
// still promising to sync. With it gone, this controller has no remaining use
// for `LocalPrefs` — the constructor no longer takes one. See local_prefs.dart's
// header for the full retirement note.

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../ui/tokens.dart' show AppThemeMode, FlowMicTheme;

/// The writing system a UI language is set in.
///
/// Mirrors the `script` field of `packages/protocol/src/locales.ts` (ISO 15924).
/// It is an ENUM and not a string on purpose: the one consumer that has to keep
/// a per-script table (the Ahem width ruler in
/// `test/wp5_rendered_copy_legibility_test.dart`) switches over it exhaustively,
/// so **a new LANGUAGE needs no edit there, while a new SCRIPT fails to
/// compile** — which is the honest split, because a new language in an existing
/// script really does inherit a defensible ruler, and a new script really does
/// need somebody to measure one.
///
/// ⚠️ `hans` and `hant` are one script in Unicode; the registry says so too. No
/// script-based rule can tell zh-CN from zh-TW — that guard is a vocabulary
/// check, never a codepoint check (doc 17 §4/§5).
enum LocaleScript { hans, hant, latn, jpan, kore, cyrl }

/// The explicit UI language. NEVER derived from the OS locale (red line).
///
/// 🔴 THIS LIST MIRRORS `packages/protocol/src/locales.ts` — the registry is the
/// SSOT for 「which languages does the product have」, and this enum is the Dart
/// face of it. Order is the registry's order, and the registry's comment says
/// why that matters: the order IS the picker order on every surface, because
/// every picker iterates `AppLocale.values` rather than spelling out rows.
/// owner 2026-08-14: 「en > zh-CN > zh-TW > fr > de > ja > ko > ru」 (with `es`
/// between `fr` and `de`, as owner enumerated it in the same day's first
/// instruction).
///
/// ⚠️ MIRRORS, not DERIVES — and that is a real gap, stated rather than hidden.
/// `scripts/i18n/gen-mobile-dart.mjs` generates the string catalogue from the
/// registry but does NOT generate this enum, so 「a new language is a registry
/// row plus a data file, and nothing else」 is true of the catalogue and false
/// of this line. It is not a theoretical gap: it is exactly how the five
/// languages added on 2026-08-14 shipped a tree where the generated catalogue
/// named `AppLocale.fr` and this enum did not have it — 66 test files failed to
/// compile, and `flutter analyze` reported **0 errors** the whole time, because
/// `analysis_options.yaml` excludes `**/*.g.dart` from analysis. Until the
/// generator owns this enum, the gate that catches a drift here is
/// `flutter test`, and nothing else.
///
/// The [endonym] is the language's name IN ITSELF, and it is deliberately NOT
/// translated per locale (same ruling as the registry's): someone looking at an
/// app in a language they cannot read is hunting for their own language's name,
/// not for its translation into the current one.
enum AppLocale {
  // The member NAME is the persisted tag (`_prefs.setString(_kLocale,
  // next.name)`), which is why `zh-CN` is spelled `zh` and `zh-TW` is `zhTw`:
  // Dart enum members cannot contain a hyphen, and `zh`/`en`/`ja`/`ko` are
  // already on disk on every install that predates 2026-08-14. Renaming any of
  // those four would silently reset those users to the default.
  en('English', LocaleScript.latn),
  zh('中文', LocaleScript.hans),
  zhTw('繁體中文', LocaleScript.hant),
  fr('Français', LocaleScript.latn),
  es('Español', LocaleScript.latn),
  de('Deutsch', LocaleScript.latn),
  ja('日本語', LocaleScript.jpan),
  ko('한국어', LocaleScript.kore),
  ru('Русский', LocaleScript.cyrl);

  const AppLocale(this.endonym, this.script);

  /// The language's name in its own script. Locale-invariant by ruling.
  final String endonym;

  /// The writing system, for the per-script rules that used to be hand-written.
  final LocaleScript script;
}

/// Fresh-install / never-chosen / unrecognised UI language. NEVER the OS.
/// owner 2026-08-14: "a fresh install boots in English" (「全新安装以英文
/// 启动」).
///
/// A stored `'zh'` is a real choice and is parsed on its own branch — collapsing
/// it into this fallback would flip every existing Chinese user to English.
const AppLocale kDefaultUiLocale = AppLocale.en;

// ── SPOKEN LANGUAGE (source_lang) ────────────────────────────────────────────
//
// 🔴 This is a **different question** from [AppLocale], and the two must
// NEVER be merged (CLAUDE.md's #1 bug shape, "one value answering two
// questions"):
//   · [AppLocale] answers "which script does the UI render in" — a closed
//     set, four enum values, purely local;
//   · this one answers "what language am I speaking in" — it **goes on the
//     wire** (`audio:start.source_lang`), it is a **lookup key** into the
//     server's STT routing table, and its value space is an open string.
// If the two shared one value, "switch the UI to English" would silently
// also switch speech recognition to English.
//
// 🔴 The label vocabulary = **BARE ISO 639-1 codes** (`zh` / `en` / `ja` /
// `ko`), NOT `zh-CN`. The criteria (not secondhand — each is grep-able):
//   ① Route matching is **exact string equality**:
//      `apps/server-core/src/stt/engine-router.ts`
//      `rows.find((c) => c.language === language)`;
//   ② the table the server seeds for every account uses exactly these bare
//      codes: `apps/server-core/src/settings/defaults.ts`
//      `routingFromPreset('zh', …)` + `routingFromPreset('*', …)`;
//   ③ the two `language_hint: 'zh-CN'` occurrences in the presets
//      (`packages/protocol/src/engine-presets.ts`) **do NOT participate in
//      routing** — a repo-wide grep for `language_hint` readers turns up only
//      one assertion in `packages/protocol/test/engine-presets.test.ts`,
//      zero consumers at runtime.
// ⇒ Sending `zh` hits ①'s exact entry; sending `en`/`ja`/`ko` falls through
//   to the wildcard `'*'` entry (SenseVoice, multilingual), which is a
//   **deliberately designed general-purpose entry point**, not a silent
//   collapse — and `configFromRouting` copies the requested language verbatim
//   into the engine config, so the vendor-side language hint genuinely does
//   change with it (`apps/server-core/src/stt/engine-router.ts`'s
//   `configFromRouting`).
// ⚠️ 0.3.0 W1 (2026-08-06) added a layer of **authorship** on top of ①: the
//   two seeded rows now carry a provenance marker, ranked **after** the
//   platform-managed default (`settings/provenance.ts`).
//   **This bare-code criterion has not changed one bit** — exact equality is
//   still exact equality, ② still seeds bare codes; what changed is only
//   "who falls back when no managed default is configured".
// ⚠️ Switching to `zh-CN` would immediately miss ②'s exact entry and fall
//   back to `'*'` — **it would look like it still works** (the vendor hint
//   still changes), but it is no longer using the engine picked for Chinese.

/// The value when the spoken language has never been chosen. `zh` is the
/// hardcoded parameter value `PttSession.pttDown` used before this card
/// (`sourceLang = 'zh'` in `pttDown`, `apps/mobile/lib/src/ptt/ptt_session.dart`),
/// so an old install's behaviour is byte-for-byte unchanged after upgrade —
/// "never chosen" and "the old behaviour" give the same answer.
///
/// ⚠️ **Deliberately no line number here** (the original text read `:637`,
/// changed 2026-08-07 W5a): that line was later pushed down to 704 by other
/// edits this round, rotting BOTH referencing comments at once and
/// **blocking pre-commit for the whole repo**. Line numbers were previously
/// allowed in this section, but **a file that is currently being edited
/// should not be referenced by line number** — once swapped for a grep-able
/// symbol, it can move as much as it likes without rotting.
///
/// 🔴 Why `ChatController.appSettings` is nullable, and why it is **NOT** the
/// kind of "friendly default" doc 13 §7 F1 ② bans (this paragraph lives here
/// because chat_controller.dart is up against its 800-line hard cap, and this
/// call belongs to this SETTING's own reasoning, not that controller's):
///   · the default is not a **fake implementation**, it is **a documented
///     value** — this very constant. It is byte-for-byte equal to what
///     actually shipped before this change, so "the constructor didn't get
///     it passed" and "before this change" are behaviourally identical — no
///     intermediate state of "looks wired up but actually isn't";
///   · production has exactly ONE construction point (`main.dart`'s
///     composition root), and it passes the real controller
///     UNCONDITIONALLY, and the SAME instance the settings page holds; null
///     can only ever be a test double;
///   · the half that would actually deceive — "the setting was saved but
///     never went live" — is not guarded by this default at all; it is
///     guarded by `test/spoken_language_test.dart`'s groups ②③, which
///     **assert on the ACTUAL wire frame** (reverse control, measured:
///     delete the `pttDown` line ⇒ group ① stays all-green, groups ②③ go red).
const String kSpokenLangDefault = 'zh';

/// The label set the picker offers. Four of them, matching the four UI
/// languages, and coincidentally exactly the languages the wildcard-routed
/// SenseVoice covers; not a protocol-level closed set (the server accepts any
/// label) — this picker simply does not invent a longer language table on
/// behalf of a private-line user.
const List<String> kSpokenLangs = <String>['zh', 'en', 'ja', 'ko'];

// ── FB-4 THREE GLOBAL TEXT-SIZE TIERS (mobile only; owner ruling D3, 2026-08-06) ──
//
// Source: `docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md` D3 +
//       `docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md` §5.
// **NOT done on the PC side** (owner's explicit order), so this enum
// deliberately lives only on mobile.
//
// 🔴 The three coefficients are owner's ruling, not picked here: large 1.00 /
// medium 0.92 / small 0.85. "Large" = **byte-identical to today's behaviour**
// — it is 1.00, and `x * 1.0 == x` holds for every finite double. This is not
// rhetoric: `text_scale_test.dart`'s group ③ uses it as a regression assertion.
//
// ⚠️ **Only shrinking, never growing** is a layout-direction safety
// guarantee: the current state IS the largest tier, so all three tiers can
// never overflow anything with a fixed height. The reverse (someone adding a
// 1.15 tier one day) invalidates that guarantee instantly — that day must
// re-run this card's three no-overflow assertions; do not assume "adding one
// row to the tier table" is harmless.
//
// It sits next to [kSpokenLangs] because the two are the same kind of thing:
// **the legal-values table for this setting** (the enum itself is half of
// the storage contract; whitelist parsing in `load()` reads it). The
// multiplication layer is a rendering concern, living in
// `lib/src/ui/text_scale_scope.dart`.
enum AppTextScale {
  large(1.00),
  medium(0.92),
  small(0.85);

  const AppTextScale(this.factor);

  /// The coefficient multiplied **on top of the system accessibility scale**
  /// (not a replacement for it — the multiplication layer lives in
  /// `lib/src/ui/text_scale_scope.dart`'s `FlowMicTextScaler`).
  final double factor;
}

class AppSettingsController extends ChangeNotifier {
  AppSettingsController({
    required SharedPreferences prefs,
  }) : _prefs = prefs;

  final SharedPreferences _prefs;

  static const String _kLocale = 'flowmic.pref.locale';
  static const String _kThemeMode = 'flowmic.pref.themeMode';

  /// U1 — "has the first-run language question been settled?"
  ///
  /// 🔴 A SECOND KEY, and that is the point rather than a duplication:
  ///   · [_kLocale]       answers "which script does the UI render in";
  ///   · [_kLocalePrompt] answers "has this question been settled".
  /// Reading the first one for both is the trap this card names. MEASURED, not
  /// assumed: [setLocale] is the only writer of [_kLocale] and it only runs on
  /// an explicit user change (and returns early when the value is unchanged) —
  /// nothing writes it eagerly at first launch. So an upgrading user who never
  /// opened the language row and a brand-new install are BYTE-FOR-BYTE
  /// IDENTICAL on "is flowmic.pref.locale missing", while they must go opposite
  /// ways: ask / never ask. The same collapse also breaks the answer side —
  /// picking Chinese (which IS the default) writes nothing through
  /// [setLocale], so a picker gated on the language key would come back on
  /// every boot.
  static const String _kLocalePrompt = 'flowmic.pref.locale_prompt';

  /// Shown, no answer yet (the app was killed mid-question). Ask again — the
  /// alternative strands a new install in a language nobody picked.
  static const String kPromptPending = 'pending';

  /// Answered, or grandfathered onto an install that predates the picker.
  /// Never ask again.
  static const String kPromptSettled = 'settled';

  /// P-7 — "has the first-run onboarding been viewed (or skipped)".
  ///
  /// 🔴 It is the **third** first-run-related key, rather than reusing
  /// [_kLocalePrompt], because the two answer different questions (is the
  /// language question settled / is onboarding finished), and their **write
  /// timing is entirely different**:
  ///   · [_kLocalePrompt] is written right inside [load] (it doubles as the
  ///     record of "is this a brand-new install", see [_resolveFirstRunPrompt]'s
  ///     ③④);
  ///   · this key is written **only the instant the user finishes or skips
  ///     onboarding** ([finishOnboarding]).
  ///     🔴 Never eagerly pre-write it early in boot: pre-writing it would
  ///     make [_firstRunMarkers]'s exclusion table below the ONLY line of
  ///     defence, and that table is human-maintained. Writing one fewer time
  ///     is more reliable than adding one more line of defence.
  static const String _kOnboardingSeen = 'flowmic.pref.onboarding_seen';

  /// 🔴 The keys the "is this a brand-new install" judgement must **ignore**
  /// — i.e. the traces the first-run mechanism leaves behind on itself. Both
  /// directions are load-bearing, and both have a real failure shape:
  ///   ① NOT excluding [_kLocalePrompt]: `load()` writes it on its very first
  ///      run ⇒ on the second boot the onboarding gate sees a `flowmic.*` key
  ///      ⇒ judges it "an upgrade install" ⇒ **onboarding never appears**,
  ///      while the user may not even have chosen a language yet (killed on
  ///      the language page on first boot).
  ///   ② NOT excluding [_kOnboardingSeen]: the onboarding marker would make
  ///      the language gate read a brand-new install as an upgrade ⇒ **the
  ///      first-run language page never appears**. Unreachable today (the
  ///      onboarding gate never pre-writes, and the language gate always
  ///      writes on every `load()`), but it is separated from happening by
  ///      only one "which runs first" edit.
  /// ⇒ Both keys are excluded, and **the SAME exclusion table is shared by
  /// both gates**, so it can never be half-fixed one day.
  static const Set<String> _firstRunMarkers = <String>{
    _kLocalePrompt,
    _kOnboardingSeen,
  };

  /// Does this device have **any other** FlowMic preference — the witness for
  /// "brand-new install vs upgrade".
  ///
  /// ⚠️ It must be asked **before** this boot writes any of its own prefs
  /// (main.dart's U1 comment block spells out, verbatim, why `load()` runs
  /// before `openTimelinePersistence`).
  bool _hasPriorFlowmicPrefs() => _prefs
      .getKeys()
      .any((String k) => !_firstRunMarkers.contains(k) && k.startsWith('flowmic.'));

  /// 🔴 **Two separate keys** from [_kLocale], deliberately: the UI language
  /// and the spoken language are two different questions, and merging
  /// storage would let changing one silently change the other.
  static const String _kSpokenLang = 'flowmic.pref.spoken_lang';

  /// FB-4 — the global text-size tier. The fourth key, in the same family as
  /// theme (purely local, apply-and-persist immediately, whitelist parsing).
  ///
  /// ⚠️ **It is a different question from the system accessibility scale**,
  /// and the two must never be merged: the system one answers "how big does
  /// this phone's owner need text to be", this one answers "how much further
  /// does FlowMic's UI shrink on top of that". Merging them = this app's tier
  /// overriding the user's system setting — see [FlowMicTextScaler]'s comment.
  static const String _kTextScale = 'flowmic.pref.textScale';

  AppLocale _locale = kDefaultUiLocale;
  AppThemeMode _themeMode = AppThemeMode.system;
  String _spokenLang = kSpokenLangDefault;
  AppTextScale _textScale = AppTextScale.large;
  bool _needsLocaleChoice = false;
  bool _needsOnboarding = false;

  AppLocale get locale => _locale;
  AppThemeMode get themeMode => _themeMode;

  /// FB-4 — the current text-size tier. Defaults to [AppTextScale.large] =
  /// **today's behaviour**, so not a single pixel changes for an old install
  /// after upgrade ("never chosen" and "the old behaviour" give the same
  /// answer, same as [kSpokenLangDefault]).
  AppTextScale get textScale => _textScale;

  /// U1 — does this install still owe the user the one-time language question?
  /// Resolved once, in [load], before the first frame. `main.dart` renders
  /// [FirstRunLocalePage] instead of the app while this is true.
  bool get needsLocaleChoice => _needsLocaleChoice;

  /// P-7 — does this install still owe the user the one-time 3-page guide?
  /// Resolved once, in [load], **before** [needsLocaleChoice] (see the ordering
  /// note there). `main.dart` renders [FirstRunOnboardingPage] instead of the
  /// instance list while this is true — **after** the language question, so the
  /// guide is read in a language the user picked.
  bool get needsOnboarding => _needsOnboarding;

  /// The `audio:start.source_lang` that goes on the wire. See the "SPOKEN
  /// LANGUAGE" section's label-vocabulary criteria at the top of this file —
  /// this string is a lookup key into the server's routing table, not a
  /// display string.
  String get spokenLang => _spokenLang;

  /// Hydrate the device-local prefs on boot.
  Future<void> load() async {
    // Whitelist parse: a stored value that is not one of the explicit
    // languages falls back to [kDefaultUiLocale] — never throws, never asks
    // the OS locale. Every real tag, `'zh'` included, resolves on its own: a
    // stored choice is not the never-chosen case, and must survive a default
    // flip.
    //
    // 🔴 Iterates [AppLocale.values] rather than spelling the tags out. The
    // hand-written switch this replaces listed exactly the four languages that
    // existed when it was written, so it did not fail to compile when five more
    // arrived on 2026-08-14 — it just quietly answered [kDefaultUiLocale] for
    // every one of them, which would have looked to a French user like "the app
    // forgets my language every launch". A lookup cannot go stale that way.
    final String? storedLocale = _prefs.getString(_kLocale);
    _locale = AppLocale.values.firstWhere(
      (AppLocale l) => l.name == storedLocale,
      orElse: () => kDefaultUiLocale,
    );
    _themeMode = switch (_prefs.getString(_kThemeMode)) {
      'light' => AppThemeMode.light,
      'dark' => AppThemeMode.dark,
      _ => AppThemeMode.system,
    };
    // Same whitelist parsing as locale: a stored value not among the four the
    // picker offers falls back to the documented default — never throws,
    // never sends a label upstream we never meant to send (the routing table
    // matches exactly; a wrong label silently falls to the wildcard entry).
    final String? storedSpoken = _prefs.getString(_kSpokenLang);
    _spokenLang = kSpokenLangs.contains(storedSpoken)
        ? storedSpoken!
        : kSpokenLangDefault;
    // FB-4 — the same whitelist parsing: a stored value not among the three
    // tiers falls back to "large" = today's behaviour.
    _textScale = switch (_prefs.getString(_kTextScale)) {
      'medium' => AppTextScale.medium,
      'small' => AppTextScale.small,
      _ => AppTextScale.large,
    };
    // Push the hydrated choice into the live theme state BEFORE the first
    // frame so the app paints in the right palette from frame one. (Follow-OS
    // re-resolution on later OS flips is armed by FlowMicTheme.init in main.)
    FlowMicTheme.setMode(_themeMode);
    // 🔴 P-7 — the onboarding gate is ordered **before** the language gate.
    //
    // Motivation: [_resolveFirstRunPrompt] has a side effect — it **writes**
    // [_kLocalePrompt]. An onboarding gate that only looks at "is there any
    // other `flowmic.*` pref" would, if ordered after it, be fooled by that
    // just-written key into "upgrade install" ⇒ **onboarding never appears**.
    // This is the same shape as the pitfall U1 itself fell into (the culprit
    // that time was the migration flag `openTimelinePersistence` writes, see
    // main.dart's U1 comment block).
    //
    // 🔴 **But this line's real load-bearing capacity is smaller than the
    // motivation above suggests, and that is measured, stated here so the
    // next person does not overestimate it**: this round, a reverse control
    // **swapped these two lines**, and `onboarding_first_run_test.dart`
    // **had not a single test go red**. The reason is that the same outcome
    // is protected by three independent lines of defence, any ONE of which
    // is sufficient on its own:
    //   ① this ordering;
    //   ② [_firstRunMarkers] excludes [_kLocalePrompt] from the witness set;
    //   ③ [_resolveFirstRunOnboarding] treats [kPromptPending] as "first-run
    //      not yet finished".
    // ⇒ **① is NOT load-bearing today.** The reason to keep it becomes a
    //   weaker but still valid one: of the three, it is the ONLY one that
    //   **does not depend on a second mechanism** — get the order right and
    //   this layer is correct on its own, even if ②③ get broken by someone
    //   one day. Writing it as "the order is part of the mechanism" would be
    //   an **overestimate**, and that very claim was already disproven by its
    //   own reverse control this round (anti-façade rule ④: a comment
    //   defending a design is itself a falsifiable assertion).
    // ⚠️ What actually saved the day is ③, and it was forced out by a
    //   **failing test**, not designed in advance — see
    //   [_resolveFirstRunOnboarding]'s comment.
    _needsOnboarding = _resolveFirstRunOnboarding();
    _needsLocaleChoice = _resolveFirstRunPrompt();
    notifyListeners();
  }

  /// P-7 — does this install still owe the 3-page onboarding.
  ///
  /// Marker already seen ⇒ no. Otherwise it depends on **whether this device
  /// is still inside the first-run flow**, and there are two independent
  /// pieces of evidence for that:
  ///   ① this device has no other FlowMic preference yet ⇒ the first boot of
  ///      a brand-new install;
  ///   ② the language question **is still pending** ([kPromptPending]) ⇒ also
  ///      a brand-new install, just one whose first boot was killed before
  ///      it finished.
  ///
  /// 🔴 ② is not a patch, it is **a real gap this round's test forced out on
  /// the spot** (when writing this card I thought ① alone was enough): a
  /// brand-new install's first boot **always** writes
  /// `flowmic.timeline.migrated.sqlite.v1` (`timeline_sqlite.dart` stamps it
  /// on EVERY install, including a brand-new one — main.dart's U1 comment
  /// block states this verbatim). So the moment the user kills the app on
  /// the language page, ① is already false on the second boot ⇒ **the
  /// language page still comes back (U1's pending branch), while onboarding
  /// has already been judged "upgrade install, no need to view"**. Judging
  /// someone who hasn't even finished picking a language as an old user is
  /// plainly wrong.
  /// ⇒ ② reads **the persistent record the language gate leaves behind on
  /// itself**: the value `pending` can only ever be written by
  /// [_resolveFirstRunPrompt]'s `!prior` (= brand-new install) branch, so it
  /// is a witness that cannot lie.
  ///
  /// 🔴 **It writes nothing at all**, deliberately, and that is also the only
  /// reason it can be ordered before the language gate.
  /// ⚠️ The remaining gap is stated plainly here, not hidden: **an install
  /// killed after answering the language page but before finishing
  /// onboarding will not automatically see onboarding again on the next
  /// boot** — by that point `locale_prompt` has already gone from `pending`
  /// to `settled`, and both witnesses have gone stale. Fixing it would
  /// require pre-writing onboarding's own pending marker early in boot,
  /// which is exactly the move U1's comment block explicitly forbids. The
  /// window is narrow (between the language page and onboarding) and the
  /// consequence is light (the settings page's "About" section's re-view
  /// entry point is always there), so **choosing not to fix it** rather than
  /// missing it. The last assertion in `onboarding_first_run_test.dart`'s
  /// group ③ pins this known gap as a test — read its comment before
  /// changing the assertion.
  bool _resolveFirstRunOnboarding() {
    if (_prefs.getBool(_kOnboardingSeen) ?? false) return false;
    if (_prefs.getString(_kLocalePrompt) == kPromptPending) return true;
    return !_hasPriorFlowmicPrefs();
  }

  /// P-7 — "finished viewing" and "skipped" land in the same place (design
  /// doc §2.1: their consequences are byte-identical).
  ///
  /// Apply-and-persist immediately: this one tap writes to disk + notifies,
  /// and `main.dart`'s ListenableBuilder switches to the instance list on the
  /// next frame. **No second writer** — `OnboardingReviewPage` (the settings
  /// page's re-view) deliberately does NOT call this: viewing it again should
  /// not change the fact, about this install, of whether first-run onboarding
  /// was ever viewed.
  void finishOnboarding() {
    _prefs.setBool(_kOnboardingSeen, true);
    if (!_needsOnboarding) return;
    _needsOnboarding = false;
    notifyListeners();
  }

  /// U1 — decide (once per install, durably) whether the language question is
  /// owed, and record the decision in the same call.
  ///
  /// 🔴 The RED LINE is intact and this is where it would break if it broke:
  /// what the repo forbids is INFERRING the language from the OS locale, not
  /// ASKING the user once. Nothing here reads the platform locale — no
  /// dispatcher lookup, no platform locale name, no `Localizations` read. The
  /// answer comes from persisted state only, and when the answer is "ask" the
  /// app stays in [kDefaultUiLocale] until a human taps.
  /// `settings_page_widget_test.dart`'s RED LINE case still pins that, and
  /// `first_run_locale_test.dart` adds the first-run half.
  ///
  /// The four cases:
  ///   ① settled → no. Answered, or grandfathered by ③.
  ///   ② pending → yes. We asked and never got an answer.
  ///   ③ no marker, but this install already holds FlowMic prefs → it predates
  ///      the picker (an upgrade). Grandfather it: write settled, never ask.
  ///      Writes the PROMPT key, never the LOCALE key — the user's status quo
  ///      is preserved rather than re-declared as a choice they never made.
  ///   ④ no marker, nothing stored at all → a genuinely new install. Ask.
  ///
  /// 🔴 ORDERING IS PART OF THE SIGNAL, and it is measured, not hoped for:
  /// `main.dart` calls [load] immediately after `SharedPreferences.getInstance`
  /// and BEFORE `openTimelinePersistence`, which writes
  /// `flowmic.timeline.migrated.sqlite.v1` on the first boot of EVERY install
  /// including a brand-new one (timeline_sqlite.dart — the migration finds
  /// nothing, and still stamps the flag). Resolve this after that line and
  /// every install looks like an upgrade ⇒ a picker that never fires, which is
  /// exactly the façade this card exists to prevent. `first_run_locale_test.dart`
  /// pins the case with that key present.
  ///
  /// ⚠️ ASYMMETRY WITH THE DESKTOP, stated so nobody「unifies」them: the desktop
  /// gate cannot use「a key exists」at all — its timeline store is constructed at
  /// ES-module scope and stamps three empty containers into a brand-new profile
  /// before any statement can run, so it has to ask whether a key holds
  /// SOMETHING (see `apps/desktop/src/lib/strings/first-run-locale.ts`). Here
  /// the ordering is something one function controls, so presence is sound —
  /// and it is the stronger signal, because it also catches an install that has
  /// state but no user content yet.
  bool _resolveFirstRunPrompt() {
    final String? mark = _prefs.getString(_kLocalePrompt);
    if (mark == kPromptSettled) return false;
    if (mark == kPromptPending) return true;
    // P-7: the witness set moved to [_hasPriorFlowmicPrefs] so the onboarding
    // gate above and this one cannot disagree about what「a prior pref」means.
    // Behaviourally identical to the `k != _kLocalePrompt` filter it replaces
    // for every profile that exists today — [_kOnboardingSeen] is the only key
    // it additionally ignores, and that key can only be present on a profile
    // that already has other flowmic prefs (see [finishOnboarding]).
    final bool prior = _hasPriorFlowmicPrefs();
    _prefs.setString(_kLocalePrompt, prior ? kPromptSettled : kPromptPending);
    return !prior;
  }

  /// U1 — the answer to the first-run question.
  ///
  /// 🔴 It writes THE SAME KEY the settings row writes ([_kLocale], through this
  /// same controller), so the app never grows a second answer to "which
  /// script does the UI render in". Two deliberate differences from
  /// [setLocale], both load-bearing:
  ///   ① it persists even when [next] equals the current value — picking English
  ///      on a fresh install is a real choice, and [setLocale]'s unchanged-guard
  ///      would leave the key absent;
  ///   ② it settles the prompt marker, which is what makes the question
  ///      one-time.
  /// Apply-and-persist immediately / no save button (red line): the tap IS
  /// the choice, and [notifyListeners] re-renders the whole tree in the
  /// chosen language on the next frame — no restart.
  void chooseLocale(AppLocale next) {
    _locale = next;
    _prefs.setString(_kLocale, next.name);
    _prefs.setString(_kLocalePrompt, kPromptSettled);
    _needsLocaleChoice = false;
    notifyListeners();
  }

  /// Set the explicit UI locale (never the OS locale — red line).
  void setLocale(AppLocale next) {
    if (_locale == next) return;
    _locale = next;
    _prefs.setString(_kLocale, next.name);
    notifyListeners();
  }

  /// Sets the spoken language (the `audio:start.source_lang` on the wire).
  /// Apply-and-persist immediately, the same recipe as [setLocale]: unchanged
  /// ⇒ return directly → mutate memory → persist in the same tap → notify.
  ///
  /// ⚠️ It takes effect on **the next press-and-hold to speak**
  /// (`ChatController.pttDown` snapshots the value at the moment of
  /// PTT-down, the same §4.0 B rhythm as mode/delivery/send_policy) —
  /// changing it mid-sentence does not change the sentence being spoken.
  void setSpokenLang(String next) {
    // A label not in the picker's vocabulary is never persisted at all: the
    // routing table is an exact match, and writing it would just let the
    // next boot's whitelist parsing quietly swap it out — the same as
    // offering a choice that does not exist.
    if (!kSpokenLangs.contains(next) || _spokenLang == next) return;
    _spokenLang = next;
    _prefs.setString(_kSpokenLang, next);
    notifyListeners();
  }

  /// Set the theme choice (default: system = follow the OS). Apply-and-persist
  /// immediately: persists the pref AND re-resolves FlowMicTheme in the same
  /// tap, so the whole app re-tints without a restart.
  void setThemeMode(AppThemeMode next) {
    if (_themeMode == next) return;
    _themeMode = next;
    _prefs.setString(_kThemeMode, next.name);
    FlowMicTheme.setMode(next);
    notifyListeners();
  }

  /// FB-4 — sets the global text-size tier. **The same recipe** as
  /// [setThemeMode] (unchanged ⇒ return directly → mutate memory → persist in
  /// the same tap → notify), apply-and-persist immediately, no save button.
  ///
  /// 🔴 It takes effect on **the next frame**, not the next launch:
  /// `main.dart`'s `MaterialApp.builder` subscribes to exactly this
  /// controller, and the moment [notifyListeners] fires the whole tree
  /// relayouts against the new `textScaler`. Without this layer of
  /// subscription, this setter would just be a "saved but never went live"
  /// façade — `text_scale_test.dart`'s group ② asserts on **exactly that
  /// scaler in the render tree**, not on this field.
  void setTextScale(AppTextScale next) {
    if (_textScale == next) return;
    _textScale = next;
    _prefs.setString(_kTextScale, next.name);
    notifyListeners();
  }
}
