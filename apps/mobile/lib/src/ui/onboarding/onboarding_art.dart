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

import 'package:flutter/material.dart';

import '../tokens.dart';

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
    required this.icon,
    this.accent = false,
    this.child,
  });

  final double width;
  final double height;
  final IconData icon;
  final bool accent;
  final Widget? child;

  @override
  Widget build(BuildContext context) => Container(
    width: width,
    height: height,
    padding: const EdgeInsets.all(8),
    decoration: BoxDecoration(
      color: FlowMicColors.surface,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(
        color: accent ? FlowMicColors.brand : FlowMicColors.line,
        width: accent ? 1.6 : 1,
      ),
    ),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        Icon(icon, size: 18, color: accent ? FlowMicColors.brand : FlowMicColors.t3),
        if (child != null) ...<Widget>[const SizedBox(height: 6), child!],
      ],
    ),
  );
}

/// A stand-in for a line of 「text」 (not real text — real text would raise
/// the question 「why does it say exactly this」).
class _TextLine extends StatelessWidget {
  const _TextLine({required this.width, this.on = false});
  final double width;
  final bool on;

  @override
  Widget build(BuildContext context) => Container(
    width: width,
    height: 4,
    margin: const EdgeInsets.only(bottom: 4),
    decoration: BoxDecoration(
      color: on ? FlowMicColors.brand : FlowMicColors.line,
      borderRadius: BorderRadius.circular(2),
    ),
  );
}

/// Page 1: speak into the phone → text appears in the computer's input box.
class OnboardingArtWhat extends StatelessWidget {
  const OnboardingArtWhat({super.key});

  @override
  Widget build(BuildContext context) => _ArtCanvas(
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        _DeviceFrame(
          width: 58,
          height: 96,
          icon: Icons.mic_none,
          accent: true,
          child: Container(
            width: 34,
            height: 12,
            decoration: BoxDecoration(
              color: FlowMicColors.brandSoft,
              borderRadius: BorderRadius.circular(6),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Icon(Icons.east, size: 20, color: FlowMicColors.brand),
        ),
        const _DeviceFrame(
          width: 116,
          height: 84,
          icon: Icons.desktop_windows_outlined,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _TextLine(width: 82, on: true),
              _TextLine(width: 60, on: true),
            ],
          ),
        ),
      ],
    ),
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
          icon: Icons.devices_other_outlined,
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
