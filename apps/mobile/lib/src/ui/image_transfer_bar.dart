// SPEC-REF:
//   docs/decisions/2026-07-30-image-http-upload-and-socket-hardening.md
//   owner 2026-07-30:「image transfer needs a progress bar added at the TOP of the screen」
//
// The image-delivery progress strip at the top of the chat page. Stages are
// each stated in words (RV-30: HTTP wait ≠ socket wait); the bar is DETERMINATE
// only when the number is real (bytes on the wire over the LAN http ingress) —
// the socket path shows an indeterminate sweep rather than inventing a
// percentage. It renders nothing at all when no image delivery is in flight.

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';

import '../session/image_send_controller.dart';
import '../settings/app_strings.dart';
import 'tokens.dart';

class ImageTransferBar extends StatelessWidget {
  const ImageTransferBar({
    super.key,
    required this.progress,
    required this.onScreen,
    required this.strings,
  });

  /// Rebuild trigger only — the VALUE rendered comes from [onScreen].
  final ValueListenable<ImageSendProgress?> progress;

  /// 🔴 G-20 ⑥ — the instance-scoped read
  /// (`ImageSendController.progressOnScreen`): a transfer made on one
  /// instance's screen must not paint on another's. REQUIRED, no identity
  /// default (doc 13 §7 F1 ②): a bar silently fed the raw value would be the
  /// defect this parameter exists to remove, with nothing left to grep.
  /// Re-read inside the builder so both change sources repaint it — a progress
  /// tick fires [progress], an instance switch rebuilds the page (the
  /// controller notifies on connection edges) and re-enters build().
  final ImageSendProgress? Function() onScreen;

  final AppStrings strings;

  String _label(ImageSendProgress p) {
    switch (p.stage) {
      case ImageSendStage.preparing:
        return strings.imageStagePreparing;
      case ImageSendStage.uploading:
        final double? f = p.fraction;
        if (f == null) return strings.imageStageUploading;
        return '${strings.imageStageUploading} · ${(f * 100).round()}%';
      // RV-30: the two waits are different facts — never one shared sentence.
      case ImageSendStage.waitingHttpVerdict:
        return strings.imageStageWaitingHttpVerdict;
      case ImageSendStage.waitingSocketAck:
        return strings.imageStageWaitingSocketAck;
    }
  }

  @override
  Widget build(BuildContext context) =>
      ValueListenableBuilder<ImageSendProgress?>(
        valueListenable: progress,
        builder: (BuildContext context, ImageSendProgress? _, __) {
          // G-20 ⑥: the scoped read, not the notifier's raw value.
          final ImageSendProgress? p = onScreen();
          if (p == null) return const SizedBox.shrink();
          return Container(
            margin: const EdgeInsets.fromLTRB(14, 10, 14, 0),
            padding: const EdgeInsets.fromLTRB(13, 10, 13, 12),
            decoration: BoxDecoration(
              color: FlowMicColors.brandSoft,
              border: Border.all(color: const Color(0x4D818CF8)),
              borderRadius: BorderRadius.circular(13),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(Icons.image_outlined, size: 14, color: FlowMicColors.brand),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _label(p),
                        style: TextStyle(
                          color: FlowMicColors.brand,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    // Real fraction on the http upload; indeterminate sweep
                    // everywhere a number would be an invention.
                    value: p.stage == ImageSendStage.uploading ? p.fraction : null,
                    minHeight: 4,
                    backgroundColor: const Color(0x33818CF8),
                    color: FlowMicColors.brand,
                  ),
                ),
              ],
            ),
          );
        },
      );
}
