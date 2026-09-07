// Card RC-1b — ONE RECORDING ON THE PENDING-RECOVERY SCREEN.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-3 no playback/export, O-5 the user's own delete,
//     O-8 no 「send to PC」)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A8-1 P2-10 (the copy branches on real capability)
//   apps/mobile/lib/src/session/pending_recovery.dart (which buttons exist)
//
// ── ITS OWN FILE ────────────────────────────────────────────────────────────
// pending_recovery_page.dart owns the LIST (load, reload, act, refuse); this
// owns one card's face. The split is the same one plus_panel_notes_tab.dart
// made from plus_panel.dart, and it keeps both files well inside the audit's
// 700-line discipline (§A9) with room for the reasoning to stay in.
//
// 🔴 THE THREE ACTIONS THAT ARE NOT HERE ARE NOT MISSING. There is no play, no
// export and no 「send to PC」: O-3 refuses the first two outright, and O-8
// refuses the third. §A8-1 P2-10 ② is the rule that makes their ABSENCE a
// requirement rather than a gap — copy or an affordance that named an action
// with no entry point would be a promise nothing keeps. A reader looking for
// them should stop here rather than add them.

import 'package:flutter/material.dart';

import '../session/pending_recovery.dart';
import '../settings/app_strings.dart';
import '../timeline/entry_metrics.dart';
import 'tokens.dart';

/// One recording: when, how long, one sentence, and whatever it may offer.
class PendingRecoveryCard extends StatelessWidget {
  const PendingRecoveryCard({
    super.key,
    required this.item,
    required this.strings,
    required this.onRetry,
    required this.onDelete,
  });

  final PendingRecoveryItem item;
  final AppStrings strings;

  /// Null ⇒ the retry button is not drawn. The page passes null while a
  /// recording is running or while an action is in flight — and
  /// [PendingRecoveryItem.actions] is what decides whether the button exists at
  /// all, which is a different question and is answered one layer down.
  final VoidCallback? onRetry;

  /// Null ⇒ the delete button is not drawn, for the same reason [onRetry] is
  /// withheld: an action is already in flight on this screen. Owner ruling
  /// O-5's deletion is still the one this card exists to offer - it is
  /// withheld for the second it takes, never drawn-and-inert (R8).
  final VoidCallback? onDelete;

  /// §A8-1 P2-10 — one sentence per state, chosen here and nowhere else.
  ///
  /// 🔴 EXHAUSTIVE WITH NO DEFAULT. A `default` arm would let a state added
  /// later inherit somebody else's sentence, silently, on a screen whose whole
  /// job is to say which of five different things is true.
  static String sentenceFor(PendingRecoveryState state, AppStrings s) =>
      switch (state) {
        PendingRecoveryState.waitingAuto => s.pendingRecoveryStateWaiting,
        PendingRecoveryState.needsManual => s.pendingRecoveryStateNeedsManual,
        PendingRecoveryState.settledUnverified =>
          s.pendingRecoveryStateUnverified,
        PendingRecoveryState.settledServerKeepsAudio =>
          s.pendingRecoveryStateServerKeepsAudio,
        PendingRecoveryState.emptyResult =>
          s.pendingRecoveryStateEmptyResult,
        PendingRecoveryState.serverUnsupported =>
          s.pendingRecoveryStateServerUnsupported,
        PendingRecoveryState.cancelled => s.pendingRecoveryStateCancelled,
        PendingRecoveryState.unreadable => s.pendingRecoveryStateUnreadable,
      };

  @override
  Widget build(BuildContext context) {
    final bool mayRetry =
        item.actions.contains(PendingRecoveryAction.retryNow) &&
            onRetry != null;
    return Container(
      key: ValueKey<String>('pendingRecovery.card.${item.id}'),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(13, 11, 13, 9),
      decoration: BoxDecoration(
        color: FlowMicColors.surface2,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: FlowMicColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          _meta(context),
          const SizedBox(height: 5),
          Text(
            sentenceFor(item.state, strings),
            key: ValueKey<String>('pendingRecovery.sentence.${item.id}'),
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: 12.5,
              height: 1.35,
            ),
          ),
          // Card FX-1 — 「is all of it here」, under 「what happens to it next」.
          //
          // A SECOND LINE RATHER THAN A REPLACEMENT: the state sentence above is
          // still true (this recording is still owed an attempt, and the attempt
          // can still succeed on what survived), and overwriting it would take
          // the retry button's explanation away. Absent on every healthy card.
          if (item.partlySaved) ...<Widget>[
            const SizedBox(height: 4),
            Text(
              strings.pendingRecoveryPartlySaved,
              key: ValueKey<String>('pendingRecovery.partlySaved.${item.id}'),
              style: TextStyle(
                color: FlowMicColors.t3,
                fontSize: 11.5,
                height: 1.35,
              ),
            ),
          ],
          const SizedBox(height: 9),
          Row(
            children: <Widget>[
              if (mayRetry) ...<Widget>[
                _button(
                  key: ValueKey<String>('pendingRecovery.retry.${item.id}'),
                  label: strings.pendingRecoveryRetryNow,
                  ink: FlowMicColors.brand,
                  background: FlowMicColors.brandSoft,
                  onTap: onRetry!,
                ),
                const SizedBox(width: 8),
              ],
              if (onDelete != null)
                _button(
                  key: ValueKey<String>('pendingRecovery.delete.${item.id}'),
                  label: strings.confirmDelete,
                  ink: FlowMicColors.red,
                  background: FlowMicColors.redSoft,
                  onTap: onDelete!,
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// When it was recorded and how much of it there is.
  ///
  /// 🔴 THE DATE IS OMITTED RATHER THAN GUESSED when this build cannot read one
  /// out of the identifier ([recordedAtMsFromId] says when that happens). A
  /// fabricated 「just now」 on week-old audio is worse than a card with one
  /// line: the user would use it to decide what to delete.
  Widget _meta(BuildContext context) {
    final int? at = item.recordedAtMs;
    final String duration = formatEntryDuration(item.durationMs);
    final String when = at == null
        ? duration
        : '${MaterialLocalizations.of(context).formatMediumDate(
            DateTime.fromMillisecondsSinceEpoch(at).toLocal(),
          )} · $duration';
    return Text(
      when,
      key: ValueKey<String>('pendingRecovery.meta.${item.id}'),
      style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
    );
  }

  Widget _button({
    required Key key,
    required String label,
    required Color ink,
    required Color background,
    required VoidCallback onTap,
  }) =>
      InkWell(
        key: key,
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 13),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: ink.withValues(alpha: 0.4)),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: ink,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      );
}
