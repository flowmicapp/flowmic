// Card RC-1b — THE TWO DOORS INTO THE PENDING-RECOVERY SCREEN, in one place.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/pending_recovery_page.dart (the screen)
//   apps/mobile/lib/src/ui/pending_recovery_entry.dart (door 1, the row)
//   apps/mobile/lib/src/ui/chat_banner_sources.dart (door 2, the banner)
//
// 🔴 IT EXISTS FOR A LINE BUDGET, AND THAT IS WORTH WRITING DOWN. The screen
// that hosts both doors, `chat_flow_page.dart`, sits at 793 of the 800-line
// `verify:lint file-size` cap; `plus_panel.dart` is at exactly 800. The audit's
// own discipline (§A9) is that a file at the cap gets SPLIT, never squeezed —
// 「压掉的都是说理文字，那是本仓最贵的东西」. So the wiring lives here and each
// door costs the page one line.
//
// ⚠️ IT IS ALSO THE HONEST SEAM: both doors must open the SAME page over the
// SAME source, and two call sites building their own would be two answers to
// one question the first time one of them was edited.

import 'package:flutter/material.dart';

import '../session/chat_controller.dart';
import '../settings/app_strings.dart';
import 'pending_recovery_entry.dart';
import 'pending_recovery_page.dart';

/// Door 1 — the row on the light-record screen. Draws nothing when this phone
/// is holding no audio the screen has anything to say about.
Widget pendingRecoveryEntryFor(ChatController c, AppStrings strings) =>
    PendingRecoveryEntry(
      source: pendingRecoveryOf(c),
      strings: strings,
      backfill: c.backfill.progress,
    );

/// Door 2 — the retained-audio banner's action.
///
/// The banner already says WHAT happened to a retained file; this is the step
/// that lets the user act on it without first knowing that a list exists.
/// `chat_banner_sources.dart` only attaches it when
/// `BackfillProgress.hasKeptAudio` — a banner action that opened an empty page
/// would be the affordance R8 forbids.
Future<void> openPendingRecoveryPage(
  BuildContext context,
  ChatController c,
  AppStrings strings,
) =>
    Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => PendingRecoveryPage(
          source: pendingRecoveryOf(c),
          strings: strings,
        ),
      ),
    );
