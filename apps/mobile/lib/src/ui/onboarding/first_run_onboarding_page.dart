// SPEC-REF:
//   docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §2.1 (when it
//     appears and how it exits)
//     + owner's ruling 7-1 (skipping is allowed) / 7-2 (the reopen entry point
//     lives in the settings page's 「About」 section)
//   apps/mobile/lib/src/ui/first_run_locale_page.dart (the structural template:
//     replace `home` full-screen,
//     exit relies on the controller's notify, not Navigator.pop, not an
//     onDone callback)
//   apps/mobile/lib/main.dart (the ternary branch on the `home:` ListenableBuilder)
//
// P-7's first-run onboarding has **two entry points**, one shared content
// (the content lives in onboarding_view.dart).
//
// ── ① FirstRunOnboardingPage — the first-run path ────────────────────────────────────
// After the language page, before the instance list, **replaces home
// full-screen** (same method as U1, same reason too: the interface behind it
// is meaningless right now to a new user who has not paired yet). Exits via
// [AppSettingsController.finishOnboarding], which notifies → main.dart's
// ListenableBuilder rebuilds → the instance list is the very next frame.
// **No Navigator.pop, no onDone**
// — this half is a verbatim copy of `FirstRunLocalePage`'s precedent.
//
// ── ② OnboardingReviewPage — the reopen path ─────────────────────────────────
// Pushed from the settings page's 「About」 section (the one and only caller:
// the `settings.openGuide` line in `settings_preferences.dart`, greppable). It
// is a plain route, so exit is
// `Navigator.pop`; it **does NOT touch that pref** — reviewing it again must
// not change the fact of 「whether the first-run onboarding has been seen」
// (that is a fact about the install, not about this particular tap).
//
// 🔴 Why two pages rather than one page with a boolean switch: the two paths'
// **exit mechanisms** differ
// (the controller's notify vs. Navigator.pop), and 「how to exit」 is exactly
// what U1's comment spent the most
// space explaining. Using one boolean to fold two exits into one widget is
// handing two questions to one
// value to answer — this repo's #1 bug shape. Each of the two widgets has only
// one way to exit, so the reader
// does not first need to know what that boolean is. The only thing shared is
// **the content** (OnboardingView), which is the one thing that genuinely
// should exist as a single copy.

import 'package:flutter/material.dart';

import '../../settings/app_settings.dart';
import '../../settings/app_strings.dart';
import '../tokens.dart';
import 'onboarding_view.dart';

/// The first-run path: the screen right after language selection.
class FirstRunOnboardingPage extends StatelessWidget {
  const FirstRunOnboardingPage({super.key, required this.appSettings});

  /// The **SAME** controller instance the settings page / language page use
  /// (main.dart's composition root).
  final AppSettingsController appSettings;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = AppStrings.of(appSettings.locale);
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      body: SafeArea(
        child: OnboardingView(
          strings: s,
          finishLabel: s.onboardingStart,
          // 「finished reading」 and 「skipped」 land in the same place (design
          // draft §2.1: the two have byte-identical consequences).
          // 🔴 The mark is written at exactly **this moment**, not pre-written
          // at launch — pre-writing would pollute the next 「first time」
          // determination, the reason is written in full in
          // AppSettingsController._resolveFirstRunPrompt
          // and in main.dart's U1 comment block.
          onFinish: appSettings.finishOnboarding,
        ),
      ),
    );
  }
}

/// The reopen path: the page pushed from the settings page's 「About」 section
/// → 「View usage guide」.
class OnboardingReviewPage extends StatelessWidget {
  const OnboardingReviewPage({super.key, required this.appSettings});

  final AppSettingsController appSettings;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = AppStrings.of(appSettings.locale);
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      body: SafeArea(
        child: OnboardingView(
          strings: s,
          finishLabel: s.onboardingClose,
          // pop, and pop is **all** it does: does not write the pref, does not touch needsOnboarding.
          onFinish: () => Navigator.of(context).maybePop(),
        ),
      ),
    );
  }
}
