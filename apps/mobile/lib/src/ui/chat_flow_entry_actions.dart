// VERBATIM MOVE out of chat_flow_page.dart (800-line cap: that file stood at
// 797/800 and card FB-7 has to mount a selection surface in it). Two families
// came across, both of which act on an EXISTING row rather than building the
// page:
//   ① `_onLongPress` — the entry context menu's dispatcher.
//   ② `_sendRetryTargets` + `_retryFailedSend` — the send-failure banner's resend.
//
// Same mechanical shape as chat_flow_composer.dart's `Routed` functions (see
// that file's header): each old private INSTANCE method becomes a top-level
// function taking the explicit receiver `_ChatFlowPageState s` first — `part of`
// keeps private-member access (`s.controller`, `s._toast`, `s._pager`) legal
// because privacy in Dart is per-library. chat_flow_page.dart keeps all three
// original method names as one-line delegations, so every call site there is
// untouched.
//
// 🔴 Diff discipline: nothing in any Routed body differs from the original
// method body beyond the three signature lines and the receiver prefixes
// (`controller` -> `s.controller`, `_toast(` -> `s._toast(`, `_pager` ->
// `s._pager`), plus ONE whitespace re-indent: `_sendRetryTargetsRouted`'s `=>`
// no longer fits on the signature line, so its argument block is re-aligned
// under it. Any other diff is a bug.

part of 'chat_flow_page.dart';

Future<void> _onLongPressRouted(
  _ChatFlowPageState s,
  BuildContext context,
  TimelineEntry entry,
  AppStrings strings,
) async {
  final EntryAction? action = await showEntryContextMenu(context, entry, strings: strings);
  if (action == null) return;
  switch (action) {
    case EntryAction.reInject:
      s.controller.reInject(entry);
    case EntryAction.reprocess:
      // GA-13: re-run the CURRENT mode over the original words. A failure to
      // even start is said out loud here; the run's own terminal is reported
      // through the usual compose banner.
      //
      // Card F3: the refusals split into two, because they send the user to two
      // different actions — 「this row/this mode cannot be rerun」 is permanent
      // until they
      // change something, 「the previous run is still going」 is over in seconds. Collapsing them
      // into one toast would tell a user whose only problem is timing that the
      // action does not apply to their row.
      final AiComposeFailure? failed = s.controller.reprocessEntry(entry);
      if (!context.mounted) return;
      if (failed == AiComposeFailure.busy) {
        s._toast(context, strings.reprocessBusy);
      } else if (failed != null) {
        s._toast(context, strings.reprocessUnavailable);
      }
    case EntryAction.copy:
      // owner 2026-07-27: a picture row copies the PICTURE. Only the bounded
      // preview survives on this phone, so the outcome is announced — the one
      // silent branch is a plain text copy, which is what it always did.
      final ImageCopyOutcome copied = await copyEntryToClipboard(entry);
      final String? note = strings.imageCopyResult(copied);
      if (note == null || !context.mounted) return;
      s._toast(context, note);
    case EntryAction.favorite:
      // F-5 turning a history row into a favourite: local only — the row itself is untouched (no status
      // change, no edit bit, no wire traffic). Feedback is mandatory: a
      // long-press that appears to do nothing reads as a broken menu item.
      final FavoriteAddOutcome outcome = await s.controller.favorites.add(
        entry.displayText,
      );
      if (!context.mounted) return;
      s._toast(context, strings.favoriteAddResult(outcome));
    case EntryAction.delete:
      // owner 2026-07-27: the context menu's delete used to fire on the tap that
      // selected it — the last item in a list you reached by long-pressing.
      if (!context.mounted) return;
      final bool sure = await confirmDestructive(
        context,
        title: strings.deleteEntryConfirmTitle,
        message: strings.deleteEntryConfirmBody,
        confirmLabel: strings.confirmDelete,
        cancelLabel: strings.cancel,
      );
      if (sure) {
        s.controller.deleteEntry(entry);
        // Card F10: the pager may be holding its own copy of this row (it came
        // from a page the store never loaded). Dropping it here keeps the row
        // from repainting the instant the store notifies — which would read
        // as 「the delete didn't take effect」.
        s._pager.forget(entry.id);
      }
    case EntryAction.select:
      // 🔴 Card FB-7 — enter selection mode, seeded with the row the user just
      // long-pressed: they pointed at it, so it is ticked. Without the seed the
      // mode opens empty and the first thing they must do is tap the row they
      // were already holding.
      //
      // Nothing else happens here. Entering a mode must not also perform an
      // action — every other case in this switch DOES something to the row, and
      // this one deliberately does not.
      s._selection.enter(seed: entry.id);
    case EntryAction.edit:
      if (!context.mounted) return;
      final EditResult? result = await Navigator.of(context).push<EditResult>(
        MaterialPageRoute<EditResult>(
          builder: (_) => EditEntryPage(entry: entry, strings: strings),
        ),
      );
      if (result == null) return;
      s.controller.editEntry(entry, result.text);
      if (result.reInject) {
        final TimelineEntry? updated = s.controller.store.findById(entry.id);
        if (updated != null) s.controller.reInject(updated);
      }
  }
}

// ── M2 / RV-15: send-failure resend ────────────────────────────────────────
/// The rows the banner's resend would re-deliver. The judgement (and the whole
/// rationale for it) lives in chat_retry_targets.dart — a pure function, so
/// 「which rows should be resent」 is unit-testable without pumping this page.
List<TimelineEntry> _sendRetryTargetsRouted(_ChatFlowPageState s) =>
    sendRetryTargets(
      failure: s.controller.sendFailure,
      // The batch ManualDelivery settled as ✗ — never a guess at the newest row.
      coveredIds: s.controller.delivery.lastFailedCoveredIds,
      store: s.controller.store,
      instanceId: s.controller.session.connectedInstanceId,
    );

/// Fire the banner's resend for every row the failed send covered. Dismiss
/// FIRST: a retry that fails again raises a FRESH failure, and dismissing
/// after the call would swallow it (no silent failures).
///
/// RV-15: this rides [ChatController.reInject] — the SAME deferred-redelivery
/// path the failed
/// row's inline resend and the long-press menu use — once per row, instead of
/// re-typing one row's text through sendFavorite. Per-row correlation is the
/// point: history:inject carries the row's own id, so each PC verdict lands
/// back on the row it belongs to.
///
/// The gap this comment used to describe is CLOSED (B2 / RV-02, 0.2.18):
/// `reInject` now runs through ManualDelivery and each row gets its OWN 20 s
/// inject:result watchdog, so N rows re-delivered by one press keep N
/// independent deadlines — a retry the PC never answers ends at ✗ with a named
/// reason instead of a permanent ⏳. A known-down link fails instantly without
/// emitting at all.
void _retryFailedSendRouted(_ChatFlowPageState s, List<TimelineEntry> entries) {
  s.controller.dismissSendFailure();
  for (final TimelineEntry entry in entries) {
    s.controller.reInject(entry);
  }
}
