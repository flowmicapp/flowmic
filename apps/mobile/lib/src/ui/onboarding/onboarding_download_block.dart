// SPEC-REF:
//   docs/ui-design/2026-08-27-nr6-onboarding-visual-upgrade-design.md §9
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md ruling ①
//     (「引导页二维码＝真实可扫」 — the guide's QR must be a REAL, scannable
//      code; the pure-Dart `qr` dependency is approved)
//
// Page 2 of the first-run guide gained a download row: 「open this on your
// computer / flowmic.app / install the desktop app」 beside a QR code carrying
// that same address. It closes owner ruling 7-3, which withheld any URL until
// the 0.3.0 distribution surface was settled — flowmic.app is now live, so the
// reason for withholding it is gone.
//
// 🔴 THE BLOCK IS NOT TAPPABLE, AND THAT IS THE DESIGN, not an omission.
//   · mechanically: `onboarding_first_run_test.dart:474-505` pins the guide's
//     tappable census at `<int>[2, 3, 3]` counted BY TYPE, so one `InkWell`
//     here breaks it whatever it is wrapped in;
//   · product-wise: a QR on the phone's own screen exists to be read by the
//     OTHER device. 「Tap it to open flowmic.app on the phone」 would answer a
//     question nobody on this page is asking — the whole page is about the
//     computer.
//
// 🔴 THE ADDRESS IS DERIVED, NEVER SPELLED. Both the QR's payload and the
// printed line come from [kDefaultSaasEndpoint]; the printed line is its HOST,
// computed here. Two literals would be two answers to 「where do people get the
// desktop app」, and the QR would be the one that quietly kept pointing at the
// old place.

import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

import '../../auth/saas_endpoint.dart' show kDefaultSaasEndpoint;
import '../../settings/app_strings.dart';
import '../tokens.dart';

/// The QR's payload — the bare site root, no path and no query.
///
/// Same discipline as `legal_urls.dart`'s header: the site decides its own
/// locale from what the browser sends, so appending `?lang=` would be a guess
/// dressed as a fact.
const String kOnboardingDownloadUrl = kDefaultSaasEndpoint;

/// What the middle line prints — `flowmic.app`, derived not typed.
String get onboardingDownloadHost => Uri.parse(kOnboardingDownloadUrl).host;

/// The download row on guide page 2.
class OnboardingDownloadBlock extends StatelessWidget {
  const OnboardingDownloadBlock({super.key, required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey<String>('onboarding.download'),
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        Semantics(
          image: true,
          label: strings.onboardingDownloadQrLabel,
          child: const ExcludeSemantics(
            child: OnboardingQrCode(data: kOnboardingDownloadUrl),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                strings.onboardingDownloadOpenOnPc,
                style: TextStyle(
                  fontSize: kOnboardingBodyMutedSize,
                  color: FlowMicColors.t3,
                  height: 1.4,
                ),
              ),
              // The one line on this page a user has to be able to copy down
              // by hand, so it is the only one wearing the primary ink and the
              // body size.
              Text(
                onboardingDownloadHost,
                key: const ValueKey<String>('onboarding.download.url'),
                style: TextStyle(
                  fontSize: kOnboardingBodySize,
                  fontWeight: FontWeight.w700,
                  color: FlowMicColors.t1,
                  height: 1.4,
                ),
              ),
              Text(
                strings.onboardingDownloadInstall,
                style: TextStyle(
                  fontSize: kOnboardingBodyMutedSize,
                  color: FlowMicColors.t3,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

/// A real, scannable QR code for [data], drawn in Dart.
///
/// The `qr` package does the encoding (owner-approved, ruling ①); everything
/// below is a `CustomPainter` filling squares, which is the same construction
/// `MicGlyph` uses. `qr_flutter` was the alternative and was not taken: it wraps
/// this same package to also offer image export and embedded logos, neither of
/// which this page needs.
class OnboardingQrCode extends StatelessWidget {
  const OnboardingQrCode({super.key, required this.data, this.size = 72});

  /// 🔴 Public so a test can assert WHAT WAS ENCODED, not merely that some
  /// squares were painted. Design §11 row 10: the assertion must compare
  /// against [kDefaultSaasEndpoint] itself, so a changed address that forgot
  /// the QR goes red.
  final String data;

  final double size;

  @override
  Widget build(BuildContext context) {
    final QrCode code = QrCode(
      payload: QrPayload.fromString(data),
      // Medium (~15%) is the package default and the usual choice for a code
      // read off a clean screen. Higher levels buy resilience against dirt and
      // print damage at the cost of a denser grid — the wrong trade for a
      // 72dp target where module size is the scarce resource.
      errorCorrectLevel: QrErrorCorrectLevel.medium,
    );
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _QrPainter(image: QrImage(code))),
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter({required this.image});

  final QrImage image;

  /// The quiet zone the QR spec asks for, in modules, on all four sides. It is
  /// not decoration: without it a scanner cannot find the finder patterns'
  /// outer edge. At 72dp with the 25-module grid `https://flowmic.app` needs,
  /// 4 modules a side leaves 72/33 ≈ 2.2dp per module — about 6.5 device pixels
  /// on a 3× screen, comfortably above what a camera resolves.
  static const int _quietModules = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final int modules = image.moduleCount;
    final double unit = size.width / (modules + _quietModules * 2);

    // 🔴 BLACK ON WHITE IN BOTH THEMES, DELIBERATELY OUTSIDE THE PALETTE.
    // This is not a surface, it is a barcode: a scanner needs dark modules on a
    // light plate, and re-tinting it for dark mode would produce a code that
    // renders beautifully and cannot be read. Precedent and the same reasoning:
    // the desktop pairing modal's white QR plate, pinned in
    // verify/lint/design-token-literals.mjs's allowlist under the same name.
    final Paint plate = Paint()..color = const Color(0xFFFFFFFF);
    final Paint module = Paint()..color = const Color(0xFF000000);

    canvas.drawRRect(
      RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(6)),
      plate,
    );
    for (int row = 0; row < modules; row++) {
      for (int col = 0; col < modules; col++) {
        if (!image.isDark(row, col)) continue;
        canvas.drawRect(
          Rect.fromLTWH(
            (col + _quietModules) * unit,
            (row + _quietModules) * unit,
            // A hair of overdraw, so neighbouring dark modules do not show a
            // seam of plate between them after fractional-pixel rounding.
            unit + 0.5,
            unit + 0.5,
          ),
          module,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.image != image;
}
