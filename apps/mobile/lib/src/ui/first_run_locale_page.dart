// U1 — the one-time first-run language question (phone).
//
// WHY IT EXISTS: this app defaults to English on both ends and deliberately
// never reads the OS locale, so a user who wants another language must pick it
// here (or later in settings). This screen is the one place that can be fixed
// without breaking the red line.
//
// 🔴 THE RED LINE IS INTACT, AND THE DISTINCTION IS THE WHOLE DESIGN: what the
// repo forbids is INFERRING the language from the OS locale; ASKING the user
// once is a different thing. Nothing in this file reads the platform locale —
// not even to pre-highlight a row. The options are flat, in the registry's
// fixed order, and the app behind this screen is still [kDefaultUiLocale] until
// a human taps. (Nine of them since 2026-08-14, which is why the column is
// inside a scroll view — it stopped fitting on a short phone.)
//
// Change applies and saves immediately (即改即存) / no save button (red line):
// the tap IS the choice. There is no
// confirm step and no skip — a skip would drop the user into the default
// language without a recorded choice, while still recording that the
// question was asked, so it would never come back.

import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'tokens.dart';

/// The language names in their OWN script (endonyms) — the only labels a
/// reader who does not yet know the UI language can act on. Fixed order, and
/// deliberately identical whatever the app is currently rendered in: an endonym
/// does not translate, so this screen reads the same to everybody.
///
/// GREPPED BEFORE WRITING (card U1 asks for exactly this): the settings row's
/// labels lived in `settings/strings/settings_strings.dart` — `langZh` /
/// `langJa` / `langKo` were the same three strings, locale-invariant there for
/// this same reason. They were NOT reused here for one measured reason:
/// `langEn` in that shard was **`'EN'`**, a two-letter chip label sized for a
/// row of chips next to a title that already said「界面语言」("UI language").
/// On a screen whose entire job is to be recognisable to someone who cannot
/// read the rest of the app, the full word is the product requirement (the
/// card spells it `English`), and that shard was owned by another lane in this
/// window — so the divergence was declared here rather than silently forked.
/// (WP3 C11, 2026-08-18: those four getters are gone — every reader,
/// including the spoken-language labels, now derives from [AppLocale].)
///
/// 🔴 原地更正 (2026-08-14): this used to be a hand-written map of four entries,
/// and it is now DERIVED from [AppLocale] — the endonym rides on the enum member.
/// 原文保留在上面：the reasoning about why these are endonyms, and why `langEn`
/// is not reused, is unchanged and is still the reason this symbol exists.
/// What changed is the failure mode. A hand-written map cannot fail to compile
/// when a language is added, so it silently loses the new entry — and every
/// read here is `kLocaleEndonyms[locale]!`, so the miss would have surfaced as a
/// null-check crash on the ONE screen a brand-new install sees first. Deriving
/// makes that unrepresentable rather than merely unlikely.
///
/// Kept as a public symbol (rather than inlining `locale.endonym`) because
/// `first_run_locale_test.dart` reads it as the list of what this screen must
/// offer, and that is a fair thing for a test to hold onto.
final Map<AppLocale, String> kLocaleEndonyms = Map<AppLocale, String>.unmodifiable(
  <AppLocale, String>{
    for (final AppLocale l in AppLocale.values) l: l.endonym,
  },
);

class FirstRunLocalePage extends StatelessWidget {
  const FirstRunLocalePage({super.key, required this.appSettings});

  /// The SAME controller the settings row uses. The tap goes through
  /// [AppSettingsController.chooseLocale], which writes the SAME
  /// `flowmic.pref.locale` — this screen is not a second answer to「界面是哪种
  /// 语言」("what language is the interface"), it is an earlier chance to give
  /// the existing one.
  final AppSettingsController appSettings;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Text(
                    'FlowMic',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: FlowMicColors.t1,
                    ),
                  ),
                  const SizedBox(height: 24),
                  for (final AppLocale l in AppLocale.values) ...<Widget>[
                    _LocaleOption(
                      locale: l,
                      onTap: () => appSettings.chooseLocale(l),
                    ),
                    const SizedBox(height: 10),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LocaleOption extends StatelessWidget {
  const _LocaleOption({required this.locale, required this.onTap});

  final AppLocale locale;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // The word「language」IN that language, straight out of the existing
    // four-language catalogue (AppStrings.uiLanguage = 界面语言 / Language /
    // 表示言語 / 언어). That is what tells a Korean reader what the screen is
    // asking, without a headline in somebody else's script — and it means this
    // screen ships four-language copy without inventing a single new key.
    final String word = AppStrings.of(locale).uiLanguage;
    return Material(
      color: FlowMicColors.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            border: Border.all(color: FlowMicColors.line),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  kLocaleEndonyms[locale]!,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    color: FlowMicColors.t1,
                  ),
                ),
              ),
              Text(
                word,
                style: TextStyle(fontSize: 12, color: FlowMicColors.t3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
