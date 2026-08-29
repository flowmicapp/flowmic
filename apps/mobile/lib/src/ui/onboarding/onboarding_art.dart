// SPEC-REF:
//   docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §2.2 (three-page
//     wireframe / 三页线框)
//     + §6-2 (illustration abstraction / 插图抽象化) + owner ruling 7-5 (ship
//     pure wireframes first / 先纯线框上线)
//   The real screens these pages narrate:
//     · page 1 = the whole closed loop, no single corresponding screen
//     · page 2 = apps/desktop/src/main-window/DevicesPage.vue
//                + apps/desktop/src/main-window/components/PairingModal.vue
//     · page 3 = apps/mobile/lib/src/ui/add_pairing_sheet.dart (scan tab)
//
// 🔴 Why hand-drawn wireframes and not screenshots (§6-2, this is the entire
// reason this file exists):
// a screenshot is a **pixel snapshot** — the moment the UI gets a redesign it
// starts telling a lie, and **nothing raises an alarm about it**.
// An abstract wireframe promises only **topology** (「there's an add-phone
// button on the computer, pressing it produces a code」), it promises no
// pixels;
// when the topology changes the guide genuinely does need updating, and a
// human will know that change happened.
// ⇒ These three illustrations are deliberately drawn to NOT resemble any real
// version of the UI. **An illustration that looks like a screenshot is the
// worst kind**:
//   it both drifts AND makes people think they're looking at the real thing.
//
// ⚠️ There is nothing tappable in the illustrations (design draft §1 「the
// guide is a narration, not a stand-in」 + this repo's red line
// 「a control that can't change anything is worse than no control at all」).
// Everything is pure drawing inside an IgnorePointer.
//
// Accessibility: the wireframes are completely blank to screen readers, so
// every image gets wrapped by its caller in a Semantics
// (label:), with the copy living in `onboarding_strings.dart`'s `onboardingArt*`.

// ── NR-6 (2026-08-27): the wireframes became BRAND figures, and page 1 plays
// a one-shot demo ────────────────────────────────────────────────────────────
// SPEC-REF: docs/ui-design/2026-08-27-nr6-onboarding-visual-upgrade-design.md
//   §3 (the illustrations) / §4 (the 1.2 s demo) — owner ruling ② of
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md approved the timing.
//
// ⚠️ NOTHING ABOVE IS REVERSED BY IT. These are still hand-drawn abstractions,
// still not screenshots, and still promise topology rather than pixels. What
// changed is that the phone is now drawn as the PRODUCT'S mark (see
// onboarding_brand_mark.dart) instead of a generic Material icon in a box, so
// three pages share one visual anchor.
//
// 🔴 THE DEMO NEEDS NO 「HAVE I PLAYED YET」 STATE, and that is a property of
// the view rather than a shortcut: `onboarding_view.dart` switches pages with a
// `collection-if`, so leaving page 1 UNMOUNTS this subtree and returning builds
// a fresh one. Stepping back to page 1 therefore replays the demo — accepted on
// purpose (someone stepping back is re-asking 「what is this thing」), and the
// alternative would be a flag to maintain for a smaller benefit.

import 'package:flutter/material.dart';

import '../tokens.dart';
import 'onboarding_brand_mark.dart';

/// The shared outer frame for all three images: a fixed-height canvas, so even
/// an extremely narrow screen never squeezes the text out.
///
/// Height **does not change with the font-size tier** (it draws lines, not
/// text), so FB-4's three tiers are neutral here.
class _ArtCanvas extends StatelessWidget {
  const _ArtCanvas({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: Container(
      height: 148,
      width: double.infinity,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: FlowMicColors.surface2,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: FlowMicColors.line),
      ),
      child: child,
    ),
  );
}

/// An abstract 「device」 frame: one screen + a few illustrative content lines
/// inside it.
class _DeviceFrame extends StatelessWidget {
  const _DeviceFrame({
    required this.width,
    required this.height,
    this.icon,
    this.accent = false,
    this.child,
    this.borderColor,
    this.leading,
  });

  final double width;
  final double height;

  /// Null when [leading] supplies the figure instead (page 2's mini mark).
  final IconData? icon;
  final bool accent;
  final Widget? child;

  /// NR-6 §4.2's closing flash: page 1's PC card lends its outline to the demo
  /// for the last 150 ms. Null ⇒ the standing rule (accent ? brand : line).
  final Color? borderColor;

  /// Drawn in place of [icon] when given.
  final Widget? leading;

  @override
  Widget build(BuildContext context) => Container(
    width: width,
    height: height,
    padding: const EdgeInsets.all(8),
    decoration: BoxDecoration(
      color: FlowMicColors.surface,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(
        color:
            borderColor ??
            (accent ? FlowMicColors.brand : FlowMicColors.line),
        width: accent ? 1.6 : 1,
      ),
    ),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        if (leading != null)
          leading!
        else if (icon != null)
          Icon(
            icon,
            size: 18,
            color: accent ? FlowMicColors.brand : FlowMicColors.t3,
          ),
        if (child != null) ...<Widget>[const SizedBox(height: 6), child!],
      ],
    ),
  );
}

/// A stand-in for a line of 「text」 (not real text — real text would raise
/// the question 「why does it say exactly this」).
class _TextLine extends StatelessWidget {
  const _TextLine({required this.width, this.on = false, this.progress = 1});
  final double width;
  final bool on;

  /// NR-6 §4.2: 0 → 1 while the demo 「types」 this line out. Defaults to 1, so
  /// every static use (pages 2 and 3, and page 1 after the demo) is unchanged.
  final double progress;

  @override
  Widget build(BuildContext context) => Container(
    width: width * progress.clamp(0.0, 1.0),
    height: 4,
    margin: const EdgeInsets.only(bottom: 4),
    decoration: BoxDecoration(
      color: on ? FlowMicColors.brand : FlowMicColors.line,
      borderRadius: BorderRadius.circular(2),
    ),
  );
}

/// Page 1: speak into the phone → text appears in the computer's input box.
///
/// The page's ONE moving figure — NR-6 §4, owner ruling ② (1.2 s, one shot,
/// silent under reduce-motion).
class OnboardingArtWhat extends StatefulWidget {
  const OnboardingArtWhat({super.key});

  /// Total run of the demo. owner ruling ② fixed the number; it is public so
  /// the test pumps THE PRODUCTION duration rather than a copy of it.
  static const Duration demoDuration = Duration(milliseconds: 1200);

  @override
  State<OnboardingArtWhat> createState() => _OnboardingArtWhatState();
}

class _OnboardingArtWhatState extends State<OnboardingArtWhat>
    with SingleTickerProviderStateMixin {
  late final AnimationController _demo = AnimationController(
    vsync: this,
    duration: OnboardingArtWhat.demoDuration,
  );
  bool _armed = false;

  /// 🔴 REDUCE-MOTION IS READ HERE AND NOWHERE ELSE FOR THIS FIGURE, and it is
  /// read in `didChangeDependencies` rather than `initState` because
  /// `MediaQuery` is an inherited lookup — `initState` is not allowed to make
  /// one. `_armed` makes it a one-shot: the callback also fires when the flag
  /// itself changes, and re-running the demo because the user toggled an OS
  /// setting would be the opposite of what they asked for.
  ///
  /// ⚠️ Reduce-motion does NOT delete the figure, it deletes the TRANSITION.
  /// `value = 1` puts every segment on its end state in the first frame, so a
  /// user with the OS setting on sees the same picture, immediately.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_armed) return;
    _armed = true;
    if (MediaQuery.disableAnimationsOf(context)) {
      _demo.value = 1;
    } else {
      _demo.forward();
    }
  }

  @override
  void dispose() {
    _demo.dispose();
    super.dispose();
  }

  /// One segment of the 1200 ms line, in milliseconds, eased.
  double _seg(double fromMs, double toMs, Curve curve) {
    final double t =
        (_demo.value * OnboardingArtWhat.demoDuration.inMilliseconds - fromMs) /
        (toMs - fromMs);
    return curve.transform(t.clamp(0.0, 1.0));
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _demo,
    builder: (BuildContext context, Widget? _) {
      // §4.2's four segments, in the order the eye is meant to follow them.
      final double phone = _seg(0, 300, Curves.easeOutBack);
      final double arrow = _seg(300, 450, Curves.easeOut);
      final double line1 = _seg(450, 750, Curves.easeOutCubic);
      final double line2 = _seg(630, 930, Curves.easeOutCubic);
      // The closing flash: out to teal by the midpoint of 1050→1200 and back,
      // expressed as the tail of the SAME controller rather than a second one.
      final double flash = 1 - (_seg(1050, 1200, Curves.linear) * 2 - 1).abs();
      return _ArtCanvas(
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Opacity(
              key: const ValueKey<String>('onboarding.demo.phone'),
              // `easeOutBack` overshoots past 1, which is the point of it on
              // the entrance — but an opacity above 1 is an assertion error, so
              // only the SCALE is allowed to overshoot.
              opacity: phone.clamp(0.0, 1.0),
              child: Transform.scale(
                scale: 0.85 + 0.15 * phone,
                child: const PhoneMark(width: 92, height: 96),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Opacity(
                key: const ValueKey<String>('onboarding.demo.arrow'),
                opacity: arrow.clamp(0.0, 1.0),
                child: Icon(Icons.east, size: 20, color: FlowMicColors.brand),
              ),
            ),
            _DeviceFrame(
              width: 116,
              height: 84,
              icon: Icons.desktop_windows_outlined,
              borderColor: Color.lerp(
                FlowMicColors.line,
                FlowMicColors.teal,
                flash,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  _TextLine(width: 82, on: true, progress: line1),
                  _TextLine(width: 60, on: true, progress: line2),
                ],
              ),
            ),
          ],
        ),
      );
    },
  );
}

/// Page 2: the computer's devices page → 「add phone」 → produces a 4-digit
/// code + QR code.
class OnboardingArtInstall extends StatelessWidget {
  const OnboardingArtInstall({super.key});

  @override
  Widget build(BuildContext context) => _ArtCanvas(
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        _DeviceFrame(
          width: 110,
          height: 84,
          // NR-6 §3.4: the generic `Icons.devices_other_outlined` gave way to a
          // COMPACT brand mark — 「the thing you are installing on that machine
          // is this product」. Compact, not full: two concentric arcs inside a
          // 110×84 card would read as noise, which is BRAND.md's own micro-tier
          // rule (drop detail rather than shrink everything).
          leading: const PhoneMark(
            width: 30,
            height: 26,
            detail: PhoneMarkDetail.compact,
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: FlowMicColors.brandSoft,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: FlowMicColors.brand),
            ),
            child: const _TextLine(width: 44, on: true),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Icon(Icons.east, size: 20, color: FlowMicColors.brand),
        ),
        Container(
          width: 74,
          height: 96,
          padding: const EdgeInsets.all(7),
          decoration: BoxDecoration(
            color: FlowMicColors.surface,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: FlowMicColors.brand, width: 1.6),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: <Widget>[
              // A stand-in for the 4-digit code: four blocks, not four real
              // digits (real digits would be typed in as if they were an
              // example).
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List<Widget>.generate(
                  4,
                  (int _) => Container(
                    width: 10,
                    height: 14,
                    margin: const EdgeInsets.symmetric(horizontal: 2),
                    decoration: BoxDecoration(
                      color: FlowMicColors.brandSoft,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ),
              Icon(Icons.qr_code_2, size: 32, color: FlowMicColors.t2),
            ],
          ),
        ),
      ],
    ),
  );
}

/// Page 3: the phone's camera points at the QR code on the computer screen.
class OnboardingArtPair extends StatelessWidget {
  const OnboardingArtPair({super.key});

  @override
  Widget build(BuildContext context) => _ArtCanvas(
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        const _DeviceFrame(
          width: 58,
          height: 96,
          icon: Icons.qr_code_scanner,
          accent: true,
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Icon(Icons.east, size: 20, color: FlowMicColors.brand),
        ),
        _DeviceFrame(
          width: 100,
          height: 84,
          icon: Icons.desktop_windows_outlined,
          child: Icon(Icons.qr_code_2, size: 30, color: FlowMicColors.t2),
        ),
      ],
    ),
  );
}
