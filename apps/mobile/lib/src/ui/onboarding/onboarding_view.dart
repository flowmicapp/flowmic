// SPEC-REF:
//   docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §2 (the 3-page
//     first-run onboarding)
//     · §2.1 when it appears and how it exits (skippable = owner's ruling 7-1)
//     · §2.2 the page flow (W-1/W-2/W-3's wireframes)
//     · §2.3 the three things deliberately NOT done
//     · §6 the five anti-drift rules
//   docs/decisions/2026-08-06-p-wave-choices-by-first-responsible.md P-7
//
// This view's narration's REAL screens (§6-3's SPEC-REF anchor: every
// sentence in the onboarding is a claim about 「another place's behaviour」,
// so it must give a grep-able landing spot):
//   · page 2 → apps/desktop/src/main-window/DevicesPage.vue
//               + components/PairingModal.vue (4-digit code + locally
//               rendered QR + expiry countdown)
//   · page 3 → apps/mobile/lib/src/ui/add_pairing_sheet.dart (the scan-code
//               tab defaults in front, manual entry is the second tab) and
//               apps/mobile/lib/src/ui/ptt_bar.dart (hold to talk)
//   · 「the first time it will ask for microphone permission」→
//               apps/mobile/lib/src/ptt/mic_permission.dart
// The copy itself lives in lib/src/settings/strings/onboarding_strings.dart,
// where the two words 「扫码」("scan code") / 「手动输入」("manual entry")
// **reference** the SAME getter as PairingStrings, not a copied literal.
//
// ── STRUCTURAL CHOICES (each has an existing precedent in this repo, not
//    picked casually) ───────────────────────────────────────────────────
// Multiple steps living in one screen = **enum + setState + collection-if**,
// precedent `apps/mobile/lib/src/ui/add_pairing_sheet.dart` (grep
// `PairTab _tab` and `_tabButton`: an enum field + `setState` to switch
// tabs). Deliberately **NOT** PageView, and NOT a nested Navigator either:
//   · a nested Navigator would give 「where should the back button go」 an
//     extra answer;
//   · PageView would introduce an intermediate state that can be
//     half-swiped, while the progress dots paint whole-page integers.
//
// 🔴 [onFinish] is a callback, while `FirstRunLocalePage`'s precedent is 「no
// callback, call the controller directly and let it notify」. The
// difference is **deliberate**, and the reason is in
// first_run_onboarding_page.dart's file header: the SAME content has two
// exits (first-run goes through the controller, revisiting goes through
// Navigator.pop), and making the exit a parameter is the ONLY way to keep
// **the content in exactly one copy**; writing it as two implementations is
// exactly where this card would drift most easily.
// In production, both call sites for this callback live in that same file —
// one grep away.
//
// ⚠️ There is no operable fake control anywhere in the onboarding (§1
// 「the onboarding narrates, it does not stand in」 + this repo's red line
// 「a control that changes nothing is worse than no control at all」). The
// only things tappable on screen are page-flip / skip / finish.

import 'package:flutter/material.dart';

import '../../settings/app_strings.dart';
import '../tokens.dart';
import 'onboarding_art.dart';

/// Three pages, fixed order. The value order **IS** the page order (`index`
/// is used directly as progress).
enum OnboardingStep { what, installPc, pairAndSpeak }

class OnboardingView extends StatefulWidget {
  const OnboardingView({
    super.key,
    required this.strings,
    required this.onFinish,
    required this.finishLabel,
  });

  final AppStrings strings;

  /// The three buttons 「开始使用」("get started") / 「关闭」("close") /
  /// 「跳过」("skip") **share** this ONE exit.
  ///
  /// 🔴 Sharing it is product semantics, not laziness: the design doc §2.1
  /// says 「having watched it through **or** skipped it, set the pref flag」
  /// — the two paths' consequences are word-for-word identical, and making
  /// them two exits would be handing 「did this count as watched」 two
  /// answers.
  final VoidCallback onFinish;

  /// The last page's main button's copy. First run = `onboardingStart`,
  /// revisiting = `onboardingClose` (see onboarding_strings.dart for why
  /// those two can't be the same sentence).
  final String finishLabel;

  @override
  State<OnboardingView> createState() => _OnboardingViewState();
}

class _OnboardingViewState extends State<OnboardingView> {
  OnboardingStep _step = OnboardingStep.what;

  bool get _isLast => _step == OnboardingStep.values.last;

  void _next() {
    if (_isLast) {
      widget.onFinish();
      return;
    }
    setState(() => _step = OnboardingStep.values[_step.index + 1]);
  }

  void _back() {
    if (_step.index == 0) return;
    setState(() => _step = OnboardingStep.values[_step.index - 1]);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // Skip: top-right, **present on every page** (all three of the
        // design doc §2.2's wireframes draw it). If it only appeared on page
        // 1, a user who only discovers on page 2 that 「the PC isn't
        // installed yet」 would be trapped inside — and that is exactly the
        // scenario owner cited when ruling 「allow skip」.
        Align(
          alignment: Alignment.centerRight,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(0, 8, 8, 0),
            child: TextButton(
              key: const ValueKey<String>('onboarding.skip'),
              onPressed: widget.onFinish,
              child: Text(
                s.onboardingSkip,
                style: TextStyle(color: FlowMicColors.t3, fontSize: 13),
              ),
            ),
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  // collection-if over the enum: each page is written on its
                  // own, sharing no single 「title/body/art」 ternary — that
                  // shape would turn 「why does page 2 have an extra
                  // sentence」 into a branch inside a conditional expression,
                  // illegible.
                  if (_step == OnboardingStep.what) ...<Widget>[
                    _art(const OnboardingArtWhat(), s.onboardingArtWhat),
                    _title(s.onboardingWhatTitle),
                    _body(s.onboardingWhatBody),
                  ],
                  if (_step == OnboardingStep.installPc) ...<Widget>[
                    _art(const OnboardingArtInstall(), s.onboardingArtInstall),
                    _title(s.onboardingInstallTitle),
                    _body(s.onboardingInstallBody),
                    _body(s.onboardingCodeExpiryNote, muted: true),
                  ],
                  if (_step == OnboardingStep.pairAndSpeak) ...<Widget>[
                    _art(const OnboardingArtPair(), s.onboardingArtPair),
                    _title(s.onboardingPairTitle),
                    _body(s.onboardingPairBody),
                    _body(s.onboardingSpeakBody),
                    _body(s.onboardingSameNetworkNote, muted: true),
                  ],
                ],
              ),
            ),
          ),
        ),
        _dots(s),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 24),
          child: Row(
            children: <Widget>[
              // 「Previous step」 **does not render** on the first page
              // (rather than rendering disabled): a button that can never be
              // tapped has no explanation to give here — there's nothing
              // before page 1, and this isn't a 「temporarily can't」 action.
              // The red line requiring a disabled state to give a readable
              // reason governs the case of 「there IS a reason it can't be
              // done」; there is no reason to give here.
              if (_step.index > 0)
                Expanded(
                  child: _button(
                    key: const ValueKey<String>('onboarding.back'),
                    label: s.onboardingBack,
                    onTap: _back,
                    primary: false,
                  ),
                ),
              if (_step.index > 0) const SizedBox(width: 12),
              Expanded(
                flex: 2,
                child: _button(
                  key: const ValueKey<String>('onboarding.next'),
                  label: _isLast ? widget.finishLabel : s.onboardingNext,
                  onTap: _next,
                  primary: true,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Wireframe art + one screen-reader description. **Both must be given
  /// together**: the wireframe is blank to a screen reader, and giving only
  /// the art would turn this page into a blank sheet for someone who
  /// cannot see the screen (copy: see `onboardingArt*`).
  Widget _art(Widget art, String label) => Padding(
    padding: const EdgeInsets.only(bottom: 22),
    child: Semantics(
      image: true,
      label: label,
      child: ExcludeSemantics(child: art),
    ),
  );

  Widget _title(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text,
      key: const ValueKey<String>('onboarding.title'),
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: 19,
        fontWeight: FontWeight.w700,
        color: FlowMicColors.t1,
        height: 1.35,
      ),
    ),
  );

  /// Body text. **No `maxLines` set**: 0.2.53's lesson was 「an answer
  /// nobody can read equals no answer」, and the sentences here vary wildly
  /// across the four languages (en/ko run more than 50% longer than zh).
  /// Letting it wrap, and letting the outer view scroll, means no sentence
  /// ever gets eaten by an ellipsis.
  ///
  /// 🔴🔴 **ORIGINAL-SPOT CORRECTION (2026-08-07, W5a adversarial review
  /// P1-1, [measured]).** This paragraph's original text's last sentence
  /// was:
  ///   「——pinned by `onboarding_first_run_test.dart`'s `didExceedMaxLines`
  ///    assertion.」
  /// **It was false, and the very first half of that same sentence is what
  /// disproves it.** Without `maxLines`, `RenderParagraph.didExceedMaxLines`
  /// **is always false** (it forwards the engine's own
  /// `ui.Paragraph.didExceedMaxLines`, and with no line-count cap there is
  /// no such thing as 「exceeding the line count」) ⇒ that assertion is
  /// structurally incapable of failing, and pins down nothing.
  /// **「no `maxLines` set」 is the REASON that assertion is inert, not the
  /// conclusion it proves** — one sentence with two clauses, and the first
  /// killed the second.
  ///
  /// **What actually pins this down now is**: `expectParagraphLegible` in
  /// `test/support/legibility.dart` — it first reads the instrument (does
  /// this text have `maxLines` set or not), and if not, asserts instead 「on
  /// what grounds could it be clipped」: `softWrap` is true, `overflow` is
  /// not ellipsis, it lays out within a bounded width, and **the longest
  /// unbreakable run of characters** fits inside the box.
  /// `onboarding_first_run_test.dart`'s group ⑧ exercises exactly this.
  ///
  /// ⇒ **This is the literal shape of anti-façade ④**: a comment asserting
  /// another place's behaviour, whose truth value depends on that other
  /// code and does not itself change. Any comment of this kind must either
  /// give a grep-able anchor, or be pinned by a test that **genuinely can go
  /// red** — the previous version had neither.
  Widget _body(String text, {bool muted = false}) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: muted ? 12.5 : 14,
        color: muted ? FlowMicColors.t3 : FlowMicColors.t2,
        height: 1.55,
      ),
    ),
  );

  Widget _dots(AppStrings s) => Semantics(
    label: s.onboardingStepOf(_step.index + 1, OnboardingStep.values.length),
    child: ExcludeSemantics(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          for (final OnboardingStep step in OnboardingStep.values)
            Container(
              width: step == _step ? 18 : 7,
              height: 7,
              margin: const EdgeInsets.symmetric(horizontal: 3),
              decoration: BoxDecoration(
                color: step == _step ? FlowMicColors.brand : FlowMicColors.line,
                borderRadius: BorderRadius.circular(4),
              ),
            ),
        ],
      ),
    ),
  );

  Widget _button({
    required Key key,
    required String label,
    required VoidCallback onTap,
    required bool primary,
  }) => Material(
    key: key,
    color: primary ? FlowMicColors.brand : FlowMicColors.surface,
    borderRadius: BorderRadius.circular(12),
    child: InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        height: 46,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(
            color: primary ? FlowMicColors.brand : FlowMicColors.line,
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 14.5,
            fontWeight: FontWeight.w600,
            color: primary ? FlowMicColors.onBrandInk : FlowMicColors.t2,
          ),
        ),
      ),
    ),
  );
}
