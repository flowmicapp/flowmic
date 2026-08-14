// AppStrings copy catalogue shard: first-run onboarding (P-7 §2).
//
// SPEC-REF:
//   docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §2 / §5 (W-1~W-3)
//   docs/decisions/2026-08-06-p-wave-choices-by-first-responsible.md P-7
//
// The single external entry point remains ../app_strings.dart (AppStrings
// composes this mixin via `with`; since 0.2.67 the copy leaves `_lf…` are
// implemented by generated classes under l10n/, and this shard keeps only
// the logic and reasoning comments).
//
// 🔴 This shard was pre-established (scaffolded) by the W5a lead so that the
// five parallel lanes would not need to touch app_strings.dart — that file
// is the **single aggregation point**, and appending a mixin rewrites its
// last line (`DisclosureStrings {` → `DisclosureStrings,`), so two lanes
// appending at once would inevitably collide on the same physical line. Each
// shard belongs to one person; the aggregation point is written once by the lead.
//
// ── HOW DESIGN DOC §6-1 "SAME-ORIGIN STRINGS" LANDS IN THIS FILE ────────────
// **Button names / tab names / status words** that appear in the onboarding
// flow always reference the getter the real UI is actually using — never a
// copied literal. The cross-shard reference pattern is the same as
// `SettingsStrings.recordOnly`: this mixin only declares the signature, and
// the implementation is provided by `PairingStrings` (the `with` order makes
// it resolvable). The payoff is that **when the real UI's wording changes,
// onboarding automatically follows** — this is the cheapest anti-drift
// mechanism, and it is also anti-façade rule ④'s form on the copy surface:
// every sentence in onboarding is a claim that "asserts behaviour elsewhere",
// and the anchor must be grep-able.
//
// 🔴 **Correction made in place (2026-08-07, W5a adversarial review P1-5) —
// the sentence above, "always references... never a copied literal", was
// false the moment it was written. Original text kept, not deleted.**
// This file at the time had **exactly one spot** that was hand-copied:
// `onboardingPairBody` wrote out the `addDevice` button's name once per
// language (zh "添加设备" / en "Add device" / ja "デバイスを追加" /
// ko '기기 추가'), byte-identical to `connection_strings.dart`. Now changed
// to `$addDevice`.
// ⚠️ What matters is not "one `$` was missing" — it's that **this very
// design-defending comment is itself a specimen of anti-façade rule ④**: it
// asserts "how this entire file behaves", and it does not itself change when
// the content does ⇒ **any comment of the form "this file always does X"
// must either be pinned by a scan, or it will eventually become false.**
// The scan that now pins it lives in `test/page_guides_test.dart`'s
// "nothing in the guide re-spells a string the real UI owns" (the half that
// checks quoted-span equality).
part of '../app_strings.dart';

mixin OnboardingStrings on AppStringsLeaves {

  // ── §6-1 SAME-ORIGIN REFERENCE: the sole definitions of these three words
  // live in other shards; this file only borrows them ─────────────────────
  // grep anchor: `pairTabScan` / `pairTabManual` are implemented in
  // `lib/src/settings/strings/pairing_strings.dart`, and the production
  // renderer is `lib/src/ui/add_pairing_sheet.dart`'s `_tabs()`.
  String get pairTabScan;
  String get pairTabManual;

  /// 🔴 **This entry was added to fill a gap, 2026-08-07 (W5a P1-5).** It was
  /// originally a **hand-copied literal** once per language (zh "添加设备" /
  /// en "Add device" / ja "デバイスを追加" / ko '기기 추가'), byte-identical
  /// to the real button — exactly the thing design rule §6-1 exists to
  /// prevent, and it was living inside the very file titled "same-origin".
  ///
  /// grep anchor: implemented in `lib/src/settings/strings/connection_strings.dart`'s
  /// `addDevice`, and the production renderer is
  /// `lib/src/ui/connections_page.dart`'s `_addButton` (the main button at
  /// the bottom of the instance-list page).
  ///
  /// ⚠️ Neither of the two existing scans caught it, and each has its own
  /// blind spot, which matters more than this one line of code:
  ///   · `onboarding_first_run_test.dart`'s source scan only counts
  ///     `$pairTabScan` / `$pairTabManual` **two anchors** — it guards the
  ///     two words it knows about;
  ///   · `page_guides_test.dart`'s general scan at the time neither listed
  ///     this file, **nor** did it do anything beyond "whole-literal ==
  ///     UI string" equality, so it could not catch a **quoted span
  ///     embedded mid-sentence**. The latter has since been fixed in the
  ///     same round (quoted-span equality); the former's coverage is still
  ///     "count only those two anchors".
  String get addDevice;

  /// The skip button in the top-right corner of first-run onboarding. owner
  /// has ruled "allow skip" (P-7 7-1): the most common first-touch scenario
  /// is "the PC side isn't installed yet", and forcing a user through all 3
  /// pages in that case is pure friction.
  String get onboardingSkip =>
      _lfOnboardingSkip;

  String get onboardingNext =>
      _lfOnboardingNext;

  String get onboardingBack =>
      _lfOnboardingBack;

  /// The last page's main button (first-run path). Lands on the instance-list
  /// page, **it does NOT stand in for tapping "add device"** (design doc
  /// §2.2: the instance-list page's empty-state copy is already carrying
  /// that baton onward — onboarding does not overstep into it).
  String get onboardingStart =>
      _lfOnboardingStart;

  /// The last page's main button (**re-view** path). Deliberately a
  /// different sentence from [onboardingStart]: a user who came in from the
  /// settings page is already using the app, so telling them "start using
  /// it" would be a non-sequitur.
  String get onboardingClose =>
      _lfOnboardingClose;

  /// The accessibility reading for the progress indicator (which of the
  /// three pages). Those three dots on screen are mute to a screen reader.
  String onboardingStepOf(int step, int total) => _lfOnboardingStepOf(step, total);

  // ── W-1 Page 1: what this is ───────────────────────────────────────────
  String get onboardingWhatTitle => _lfOnboardingWhatTitle;
  String get onboardingWhatBody => _lfOnboardingWhatBody;

  // ── W-2 Page 2: install on the PC first ────────────────────────────────
  //
  // ⚠️ owner ruling 7-3: **no download URL, no QR code** here until the
  // 0.3.0 external-distribution surface is finalized. A URL that will go
  // stale is worse than no URL.
  String get onboardingInstallTitle => _lfOnboardingInstallTitle;
  String get onboardingInstallBody => _lfOnboardingInstallBody;

  /// The pairing code has an expiry. **Deliberately no concrete second count**
  /// (design doc §4.2): the TTL is a PC-side implementation detail, and
  /// hardcoding a number would inevitably drift, while all the user needs to
  /// know is "if it expires, a new one appears — just scan the latest one".
  String get onboardingCodeExpiryNote => _lfOnboardingCodeExpiryNote;

  // ── W-3 Page 3: pair, then start speaking ──────────────────────────────
  String get onboardingPairTitle => _lfOnboardingPairTitle;

  /// §6-1 same-origin: the three words "add device" / "scan" / "manual
  /// input" come from [addDevice] / [pairTabScan] / [pairTabManual]
  /// respectively — the same strings currently displayed on the
  /// instance-list page's main button and on `add_pairing_sheet.dart`'s two
  /// tabs.
  ///
  /// 🔴 [addDevice] here was, before 2026-08-07, a hand-copied literal per
  /// language (see that getter's declaration). **Not one of this sentence's
  /// three control names is copied any more** — a wording change follows
  /// automatically.
  String get onboardingPairBody => _lfOnboardingPairBody(addDevice, pairTabScan, pairTabManual);

  String get onboardingSpeakBody => _lfOnboardingSpeakBody;

  /// The LAN channel's precondition. One of the two sentences in design doc
  /// §4.2's "two common failures" — placed on the last page because it is
  /// **the most common cause of pairing failure**, not because it makes for
  /// a nice-sounding supplementary note.
  String get onboardingSameNetworkNote => _lfOnboardingSameNetworkNote;

  // ── The re-view entry point in the settings page's "About" section
  //    (owner ruling 7-2) ──────────────────────────────────────────────
  String get onboardingReviewTitle =>
      _lfOnboardingReviewTitle;
  String get onboardingReviewSub => _lfOnboardingReviewSub;

  // ── Accessibility descriptions for the illustrations ───────────────────
  //
  // 🔴 The illustrations are **wireframe schematics** (owner ruling 7-5 +
  // §6-2: no embedded real screenshots — a screenshot is a pixel snapshot
  // that drifts the moment the UI changes, with nobody to sound the alarm).
  // A wireframe is completely blank to a screen reader, so every one needs a
  // descriptive sentence — otherwise these three pages are, to a user who
  // cannot see the screen, three blank sheets of paper plus a button.
  String get onboardingArtWhat => _lfOnboardingArtWhat;
  String get onboardingArtInstall => _lfOnboardingArtInstall;
  String get onboardingArtPair => _lfOnboardingArtPair;
}
