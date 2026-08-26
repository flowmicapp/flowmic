// SPEC-REF:
//   permission/camera_permission.dart — card SCAN-PERM (2026-08-25); the whole
//     argument lives there.
//   ptt/mic_permission.dart + ui/mic_permission_banner.dart — card U2, the
//     face→surface mapping this file mirrors for the camera.
//
// Face → PANE mapping for the camera-permission flow. The scanner sheets hand
// this the flow and the slot the camera would occupy; it renders one of the
// non-camera faces in that slot, so the sheet never grows a second answer to
// 「this face means what on screen」.
//
// Every face here is a NAMED fact with a way out (never a black rectangle and
// never a banner without an action): rationale/denied carry the real OS
// request, permanently-denied carries `openAppSettings()`. The ready face is
// not rendered here on purpose — ready means 「build the scanner」, and the
// scanner is the sheet's own widget.

import 'dart:async';

import 'package:flutter/material.dart';

import '../permission/camera_permission.dart';
import '../settings/app_strings.dart';
import 'tokens.dart';

/// The height of the scanner box, shared so a face and the camera occupy the
/// same slot and the sheet does not jump when one replaces the other.
const double kScanPaneHeight = 240;

/// One of the NON-ready faces, sized like the scanner. Asserting on a ready
/// face is a caller bug: the caller renders the camera for that one.
class ScanPermissionPane extends StatelessWidget {
  const ScanPermissionPane({super.key, required this.flow, required this.strings});

  final CameraPermissionFlow flow;
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ScanPermissionFace>(
      valueListenable: flow.face,
      builder: (BuildContext context, ScanPermissionFace face, _) {
        assert(face != ScanPermissionFace.ready, 'ready renders the scanner, not this pane');
        return Container(
          key: ValueKey<String>('scan.perm.${face.name}'),
          height: kScanPaneHeight,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: BoxDecoration(
            color: FlowMicColors.surface2,
            border: Border.all(color: FlowMicColors.line),
            borderRadius: BorderRadius.circular(14),
          ),
          child: switch (face) {
            ScanPermissionFace.probing => const SizedBox.shrink(),
            ScanPermissionFace.rationale => _face(
              strings.cameraRationale,
              icon: Icons.photo_camera_outlined,
              action: strings.cameraAllowAction,
              onAction: () => unawaited(flow.requestFromSurface()),
            ),
            ScanPermissionFace.denied => _face(
              strings.cameraDenied,
              icon: Icons.no_photography_outlined,
              action: strings.cameraAllowAction,
              onAction: () => unawaited(flow.requestFromSurface()),
            ),
            ScanPermissionFace.permanentlyDenied => _face(
              strings.cameraPermanentlyDenied,
              icon: Icons.no_photography_outlined,
              action: strings.cameraOpenSettingsAction,
              onAction: () => unawaited(flow.openSystemSettings()),
            ),
            // Unreachable by the assert above; a real `ready` still must not
            // paint a refusal, so it paints nothing.
            ScanPermissionFace.ready => const SizedBox.shrink(),
          },
        );
      },
    );
  }

  Widget _face(
    String message, {
    required IconData icon,
    required String action,
    required VoidCallback onAction,
  }) => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: <Widget>[
      Icon(icon, size: 28, color: FlowMicColors.t2),
      const SizedBox(height: 12),
      // No maxLines / no ellipsis: the sentence must be readable in full
      // (0.2.53's rule — a clipped reason is a reason nobody read).
      Text(
        message,
        textAlign: TextAlign.center,
        style: TextStyle(color: FlowMicColors.t1, fontSize: 13, height: 1.4),
      ),
      const SizedBox(height: 14),
      Center(
        child: GestureDetector(
          key: const ValueKey<String>('scan.perm.action'),
          onTap: onAction,
          child: Container(
            height: 38,
            padding: const EdgeInsets.symmetric(horizontal: 22),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              // The same brand gradient the talk bar and the sheet's primary
              // button wear — a token, never a literal (design-token-literals).
              gradient: LinearGradient(colors: FlowMicColors.pttIdle),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              action,
              style: TextStyle(color: FlowMicColors.onBrandInk, fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ),
    ],
  );
}
