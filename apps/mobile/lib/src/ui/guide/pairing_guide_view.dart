// SPEC-REF:
//   the surface it narrates: apps/mobile/lib/src/ui/add_pairing_sheet.dart
//     (the add-pairing bottom sheet — scan-code tab first, manual-input second)
//   the PC side it answers for: apps/desktop/src/main-window/DevicesPage.vue and
//     apps/desktop/src/main-window/components/PairingModal.vue (4-digit code,
//     locally rendered QR, expiry countdown that refreshes itself)
//   design: docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §4 (this
//     guide), §5 W-5 (copy), §6 (the five anti-drift rules)
//
// P-7 ③ — the add-device sheet's 「point to re-read」 guide.
//
// WHY IT IS PUSHED INSIDE THE SHEET rather than opened as a second sheet or a
// route. The sheet already navigates this way — `PairTab` plus `setState` plus
// a collection-`if` swaps its whole body, with no nested Navigator and no
// PageView — and that same swap already unmounts and remounts `MobileScanner`
// every time the user moves between scan-code and manual-input. So this adds no new
// lifecycle for the camera to get wrong; it reuses one the sheet exercises on
// every tab tap. A stacked second sheet would put two modal layers on a phone
// screen for a page of text.
//
// 🔴 IT NEVER OPENS BY ITSELF (§4.3). The rejected alternative was 「pop the
// guide after N failed attempts」. A pairing failure already names its own
// reason in the sheet's error banner; covering that banner with a general
// explanation at the exact moment the specific one arrived would be a
// regression dressed as helpfulness.
//
// 🔴 TWO THINGS THIS FILE REFUSES TO SAY, both §4.2:
//   · no error-code table. The sheet fails loud with the real reason, and a
//     second table here would be a copy free to drift away from the first.
//     The trouble section says the two things a USER can act on and stops.
//   · no TTL in seconds. The code's lifetime is the PC's business and a number
//     written here would be stale the first time it is tuned. The copy says
//     what to DO instead: use whichever code the screen is showing.
//
// The sketch below is an ABSTRACT WIREFRAME (§6-2), captioned as one. It
// promises topology — 「there is a window with a code and a QR in it」 — and
// promises nothing about pixels, so a PC redesign cannot silently falsify it.
// A screenshot would promise pixels and would rot without anything going red.

import 'package:flutter/material.dart';

import '../../settings/app_strings.dart';
import '../tokens.dart';

/// The "?" that opens this guide, in the add-pairing sheet's title row.
///
/// ⚠️ Deliberately NOT built like the ✕ beside it: that one is a bare
/// `InkWell` wrapping an 18×18 `Icon` with no padding, i.e. an 18dp tap target.
/// Copying it would propagate the defect. This one is a 34dp cell, matching the
/// instance list's top-bar icons.
class PairingGuideButton extends StatelessWidget {
  const PairingGuideButton({
    super.key,
    required this.strings,
    required this.onTap,
  });

  final AppStrings strings;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    key: const ValueKey<String>('pair.guide'),
    onTap: onTap,
    borderRadius: BorderRadius.circular(10),
    child: Tooltip(
      message: strings.guidePairingTitle,
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Icon(Icons.help_outline, size: 18, color: FlowMicColors.t2),
      ),
    ),
  );
}

/// The guide body, shown in place of the sheet's tabs. Read-only: the only
/// control it contains returns to pairing.
class PairingGuideView extends StatelessWidget {
  const PairingGuideView({
    super.key,
    required this.strings,
    required this.onBack,
  });

  final AppStrings strings;

  /// Same callback the sheet's title-row back arrow fires. One behaviour, two
  /// reachable places to ask for it — not two behaviours.
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = strings;
    return ConstrainedBox(
      // Bounded and scrollable. The sheet's own Column is mainAxisSize.min with
      // no scroll view of its own — its tallest body until now was a 240px
      // camera pane — so a page of prose dropped in unbounded would overflow on
      // a short screen instead of scrolling.
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.62,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _card(<Widget>[
              _sectionTitle(s.guidePairingWhereTitle),
              _body(s.guidePairingWhereBody),
              const SizedBox(height: 10),
              const _PcScreenSketch(),
              const SizedBox(height: 6),
              _caption(s.guidePairingSketchCaption),
              const SizedBox(height: 8),
              _body(s.guidePairingCodeExpires),
            ]),
            const SizedBox(height: 10),
            _card(<Widget>[
              // The tab names come from the tabs themselves (§6-1) — rename a
              // tab and this heading follows, with nothing to remember.
              _sectionTitle(s.guidePairingScanTitle(s.pairTabScan)),
              _body(s.guidePairingScanBody),
            ]),
            const SizedBox(height: 10),
            _card(<Widget>[
              _sectionTitle(s.guidePairingManualTitle(s.pairTabManual)),
              // Both field labels, likewise read from the fields.
              _body(s.guidePairingManualBody(s.pcAddressLabel, s.pairCodeLabel, s.pcidLabel)),
            ]),
            const SizedBox(height: 10),
            _card(<Widget>[
              _sectionTitle(s.guidePairingTroubleTitle),
              _body(s.guidePairingSameNetwork),
              const SizedBox(height: 6),
              _body(s.guidePairingNewestCode),
            ]),
            const SizedBox(height: 14),
            _backButton(s.guidePairingBack),
          ],
        ),
      ),
    );
  }

  Widget _card(List<Widget> children) => Container(
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    ),
  );

  Widget _sectionTitle(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      text,
      style: TextStyle(
        color: FlowMicColors.t1,
        fontSize: 13,
        fontWeight: FontWeight.w600,
      ),
    ),
  );

  Widget _body(String text) => Text(
    text,
    style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5, height: 1.65),
  );

  Widget _caption(String text) => Text(
    text,
    style: TextStyle(color: FlowMicColors.t3, fontSize: 11, height: 1.5),
  );

  Widget _backButton(String label) => Material(
    color: FlowMicColors.surface2,
    borderRadius: BorderRadius.circular(12),
    child: InkWell(
      key: const ValueKey<String>('pair.guide.backButton'),
      onTap: onBack,
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        height: 44,
        width: double.infinity,
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    ),
  );
}

/// An abstract sketch of what the PC is showing: a window with a large code and
/// a QR beside it. Nothing here is tappable and nothing here is a real code —
/// the digits are bullets, precisely so no one can read a pairing code out of a
/// picture. §6-2: topology, not pixels.
class _PcScreenSketch extends StatelessWidget {
  const _PcScreenSketch();

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Container(
      height: 96,
      decoration: BoxDecoration(
        color: FlowMicColors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: FlowMicColors.line),
      ),
      child: Column(
        children: <Widget>[
          // Window chrome strip — the only job of these three dots is to make
          // the box read as "a window on a computer" at a glance.
          Container(
            height: 16,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: FlowMicColors.line)),
            ),
            child: Row(
              children: <Widget>[
                for (int i = 0; i < 3; i++) ...<Widget>[
                  Container(
                    width: 4,
                    height: 4,
                    decoration: BoxDecoration(
                      color: FlowMicColors.t3,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 4),
                ],
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: <Widget>[
                  // The 4-digit code, as bullets. Not a code.
                  Text(
                    '• • • •',
                    style: TextStyle(
                      color: FlowMicColors.t1,
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1,
                    ),
                  ),
                  const _QrSketch(),
                ],
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

/// A square with three corner markers — the shape everyone recognises as a QR
/// code, carrying no data at all.
class _QrSketch extends StatelessWidget {
  const _QrSketch();

  @override
  Widget build(BuildContext context) => Container(
    width: 44,
    height: 44,
    padding: const EdgeInsets.all(5),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Stack(
      children: <Widget>[
        Align(alignment: Alignment.topLeft, child: _finder()),
        Align(alignment: Alignment.topRight, child: _finder()),
        Align(alignment: Alignment.bottomLeft, child: _finder()),
        Align(
          alignment: Alignment.bottomRight,
          child: Container(width: 6, height: 6, color: FlowMicColors.t3),
        ),
      ],
    ),
  );

  Widget _finder() => Container(
    width: 11,
    height: 11,
    decoration: BoxDecoration(
      border: Border.all(color: FlowMicColors.t2, width: 2),
    ),
  );
}
