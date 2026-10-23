// FM-003 — the error strip the add-device, sign-in and scan sheets show.
//
// Those three sheets each carried a byte-identical copy of this strip with the
// icon and text painted red-300 #FCA5A5 (a dark-theme value) over
// `FlowMicColors.redSoft`. In the light theme that is 1.49:1 on the sheet's
// `surface` — the sentence telling the person why something failed could not
// be read. The ink is now `FlowMicColors.red`, the theme-resolving token whose
// light value is documented in tokens_palette.dart as chosen to clear 4.5:1 on
// its own redSoft fill (pinned by theme_tokens_test.dart 'red on redSoft').
// Measured on `surface`: light 5.08:1, dark 5.42:1 (test:
// sheet_error_banner_contrast_test.dart, which mounts the real add-device
// sheet).

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Key on the strip's container, for the contrast test to find the fill.
const ValueKey<String> kSheetErrorBannerKey = ValueKey<String>('sheet.errorBanner');

class SheetErrorBanner extends StatelessWidget {
  const SheetErrorBanner(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) => Container(
    key: kSheetErrorBannerKey,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: FlowMicColors.redSoft,
      // Same 0x4D alpha the three copies used over the dark red; in the dark
      // theme this is the identical colour.
      border: Border.all(color: FlowMicColors.red.withAlpha(0x4D)),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: <Widget>[
        Icon(Icons.error_outline, size: 14, color: FlowMicColors.red),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: TextStyle(color: FlowMicColors.red, fontSize: 12),
          ),
        ),
      ],
    ),
  );
}
