// Card RC-1b — THE WAY IN, on the light-record screen.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6 R-2 (a manual retry entry the USER CAN SEE)
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-5 — the user's own delete needs a way in too)
//   apps/mobile/lib/src/ui/pending_recovery_page.dart (what it opens)
//
// 🔴 THE SCREEN IS WORTHLESS WITHOUT A DOOR, and this is the anti-façade ⑥
// shape in CLAUDE.md, verbatim: 「接线的两端各自被测过了，中间那一段没有任何
// 东西走过」 (both ends of the wiring were tested and nothing ever walked the
// middle). A page nothing routes to is a page that does not exist, however
// green its own widget test is — so `pending_recovery_entry_test.dart` mounts
// THIS row and taps it.
//
// ⚠️ IT IS ABSENT, NOT DISABLED, WHEN THERE IS NOTHING WAITING. A permanent row
// that usually opens an empty list is the affordance R8 forbids, and it would
// also imply, every day, that something is owed.

import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';

import '../session/backfill_runner.dart';
import '../session/pending_recovery.dart';
import '../settings/app_strings.dart';
import 'pending_recovery_page.dart';
import 'tokens.dart';

/// A row that appears only while this phone is holding audio the pending screen
/// has something to say about.
class PendingRecoveryEntry extends StatefulWidget {
  const PendingRecoveryEntry({
    super.key,
    required this.source,
    required this.strings,
    this.backfill,
  });

  final PendingRecoverySource source;
  final AppStrings strings;

  /// The recovery queue's own progress, when there is one.
  ///
  /// Used ONLY as a change signal: a recovery landing (or a sweep discovering
  /// a debt) has to move this row without the user leaving the screen, and the
  /// alternative — polling the disk on a timer — would be a filesystem scan
  /// per tick for a row that is usually absent. What the row is actually built
  /// from is [PendingRecoverySource.list], because `BackfillProgress` cannot
  /// see cancelled audio (see `BackfillProgress.hasKeptAudio`, which says so
  /// and why).
  final ValueListenable<BackfillProgress>? backfill;

  @override
  State<PendingRecoveryEntry> createState() => _PendingRecoveryEntryState();
}

class _PendingRecoveryEntryState extends State<PendingRecoveryEntry> {
  bool _any = false;

  @override
  void initState() {
    super.initState();
    widget.backfill?.addListener(_onProgress);
    unawaited(_read());
  }

  @override
  void dispose() {
    widget.backfill?.removeListener(_onProgress);
    super.dispose();
  }

  void _onProgress() => unawaited(_read());

  Future<void> _read() async {
    final List<PendingRecoveryItem> rows = await widget.source.list();
    if (!mounted) return;
    final bool any = rows.isNotEmpty;
    if (any != _any) setState(() => _any = any);
  }

  Future<void> _open() async {
    await Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => PendingRecoveryPage(
          source: widget.source,
          strings: widget.strings,
        ),
      ),
    );
    // The user may have deleted the last one, or a retry may have settled it.
    if (mounted) await _read();
  }

  @override
  Widget build(BuildContext context) {
    if (!_any) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      child: InkWell(
        key: const Key('pendingRecovery.entry'),
        onTap: () => unawaited(_open()),
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: FlowMicColors.surface2,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: FlowMicColors.line),
          ),
          child: Row(
            children: <Widget>[
              Icon(Icons.mic_none, size: 15, color: FlowMicColors.t3),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.strings.pendingRecoveryEntry,
                  key: const Key('pendingRecovery.entry.label'),
                  style: TextStyle(color: FlowMicColors.t1, fontSize: 12.5),
                ),
              ),
              Icon(Icons.chevron_right, size: 16, color: FlowMicColors.t3),
            ],
          ),
        ),
      ),
    );
  }
}
