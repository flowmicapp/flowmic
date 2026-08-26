// The chat page's transient SnackBar, moved out of chat_flow_page.dart on
// 2026-08-26 (800-line cap). Verbatim apart from the name: the page keeps a
// one-line delegate so no call site moved, the same pattern the composer and
// the banner sources already came out of this file with.
//
// ⚠️ NOT the pairing confirmation. That one is a CENTRED panel with its own
// lifetime (pairing_success_toast.dart) — a SnackBar is a bottom strip and
// competes with the PTT bar, which is exactly the space the user is aiming at.

import 'package:flutter/material.dart';

import 'tokens.dart';

void showChatToast(BuildContext context, String message) {
  final ScaffoldMessengerState? messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(
          message,
          style: TextStyle(color: FlowMicColors.t1, fontSize: 12.5),
        ),
        backgroundColor: FlowMicColors.surface2,
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
}
