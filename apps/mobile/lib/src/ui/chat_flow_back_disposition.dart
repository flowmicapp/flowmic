// What a BACK gesture means on this screen, and what leaving it costs.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason and same shape as chat_flow_exits.dart / chat_flow_composer.dart
// / chat_flow_pager_sync.dart: `chat_flow_page.dart` sat at 798 against
// `verify/lint/file-size.mjs`'s SRC_MAX = 800 — two lines of headroom — and card
// 0.3.43 Q6 needed more than two. The repo's standing move at that cap is a
// STRUCTURAL SPLIT, moving a coherent family out and never deleting the
// reasoning to save lines (CLAUDE.md, 0.2.52: 按仓里成例做结构拆分而不是删证据;
// the file-size lint's own header asks for exactly this).
//
// 🔴 DIFF DISCIPLINE: [_attemptBackRouted] is the previous `_attemptBack` moved
// character-for-character apart from the one edit card Q6 makes to it (the
// `onBack?.call()` that stood before the pop, now owned by
// [_runLeaveCleanupAfterPopRouted] and argued in place). The page keeps a
// one-line delegator for each member so no call site moved. The FIELD
// `_lastBackLeaves` stays on the state — a `part` cannot add fields.
//
// ── WHY THIS SET AND NOT SOME OTHER SET ──────────────────────────────────
// Every member below reads the one question 「what does back mean right now」:
// the predicate that answers it, the listener that keeps the answer fresh, the
// disposition that acts on it, and the cleanup owed when the answer was
// 「leave」. They must move together because the predicate and the disposition
// are two readings of the SAME policy ([chatBackKind]) — splitting them is how
// a screen ends up with two different notions of what a back press does.
//
// ⚠️ NOT the same question as chat_flow_exits.dart, which is why that file was
// not simply grown. That one answers 「the screen is removing ITSELF」 (link
// dead, capsule taken, PC released) — three departures the user did not ask
// for, each owning its own teardown and its own sentence. This one answers 「the
// USER asked to leave」. The two meet at exactly one point, and it is named:
// [_leavingByAutomaticExitRouted].
//
// SPEC-REF:
//   docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q6
//   docs/rebuild/17-SPEECH-PIPELINE-STATES-AND-FLOW.md §1 (the swipe table)

part of 'chat_flow_page.dart';

/// 🔴 0.3.43 Q6 — THE BACK DISPOSITION, as one value: may a back gesture simply
/// take this page away?
///
/// WHY IT HAD TO BECOME DYNAMIC. Enabling the iOS edge-swipe made
/// [PopScope.canPop] answer a second question: `_CupertinoBackGestureDetector`
/// refuses to ARM on a route whose pop disposition is `doNotPop`, so canPop is
/// no longer just 「what does the system back button do」 but also 「can the user
/// swipe out of here at all」. The old term was `onBack != null`, which is true
/// for the whole life of the pushed page — so the gesture the owner asked for
/// was refused in EVERY state, including the clean one it was asked for.
///
/// The three blockers, each answering 「this back press means something other
/// than *leave*」:
///   · `_selection.active` — back leaves the MODE (card FB-7);
///   · `_sheetOpen` — back collapses the OVERLAY first (PA-4 / §5-2);
///   · [chatBackKind] ≠ leave — a recording must be stopped and kept, an unsent
///     draft must be confirmed. Those are the two the owner named (「录音中滑动
///     不退出、有草稿先确认」), and they are read through the SAME pure policy
///     [_attemptBackRouted] uses, not a second copy of the rule.
///
/// ⚠️ `onBack != null` IS DELIBERATELY GONE from this predicate. On the
/// home-rooted variant (`onBack == null`) that term used to let a system back
/// leave the APP mid-recording; it now stops and keeps the recording exactly as
/// the pushed variant does. That is a tightening, and it is the same sentence
/// the ruling makes about the swipe.
bool _backLeavesPageRouted(_ChatFlowPageState s) =>
    !s._selection.active &&
    !s._sheetOpen &&
    chatBackKind(
          isRecording: s.controller.isRecording,
          hasUnsentBuffer: s._hasUnsentBuffer,
        ) ==
        ChatBackKind.leave;

/// 🔴 Card FB-7's law, now owed by two MORE terms.
///
/// That card's note above `_onSelectionChanged` says canPop is computed OUTSIDE
/// `build`'s `Listenable.merge`, so a repaint-only update leaves the next back
/// press acting on a stale disposition. `isRecording` and the compose buffer
/// arrive exactly that way — through the controller, into the merge, repaint
/// only — so without this listener the FIRST back press after a recording ended
/// (or a draft was cleared) would still be judged against the previous answer.
/// Same fix as FB-7's, same reason, one screen later.
void _onBackDispositionChangedRouted(_ChatFlowPageState s) {
  if (!s.mounted) return;
  // The write goes through the page's own setter, which also owns the
  // change-detection: `setState` is `@protected` and a top-level function is not
  // a subclass of `State`. Same mechanical edit, same reason, as
  // chat_ptt_lifecycle.dart's `notifyUi` — the frame scheduler stays on the
  // class, the reasoning lives here.
  s._setBackLeaves(s._backLeavesPage);
}

/// 🔴 0.3.43 Q6 — one of the three AUTOMATIC exits is taking the page away, so
/// the departure is already spoken for.
///
/// This exists because `onPopInvokedWithResult(didPop: true)` fires for EVERY
/// pop of this route, not only for the user's back gesture — and all three exits
/// in chat_flow_exits.dart leave via `popUntil`. Running the leave cleanup for
/// them would attach `onBack` (production: the transport disconnect) to three
/// departures that deliberately do not perform one: the link is already dead
/// (session lost), or another phone holds the capsule, or the PC itself released
/// us. Each of those owns its own teardown and its own sentence to the user.
///
/// ⚠️ It reads the three latches rather than adding a fourth flag: they are
/// already set exactly when those exits are in flight, so this is a read of
/// state that already answers the question. A FOURTH automatic exit must be
/// registered here — that is the cost of this shape, stated rather than
/// discovered.
bool _leavingByAutomaticExitRouted(_ChatFlowPageState s) =>
    s._sessionLostHandled || s._capsuleTakenHandled || s._pcReleasedHandled;

/// 🔴 0.3.43 Q6 — the leave cleanup, run once the route is already gone.
///
/// The ONE place `onBack` is called from. Reached from
/// `onPopInvokedWithResult`'s `didPop == true` arm, which fires for the iOS
/// edge-swipe, the Android system back, the header ← and the post-discard exit
/// alike — see [_attemptBackRouted] for why it moved here.
void _runLeaveCleanupAfterPopRouted(_ChatFlowPageState s) {
  if (s._leavingByAutomaticExit) return;
  s.onBack?.call();
}

/// Shared exit path for header ← and system back (PopScope).
/// Uses [Navigator.pop] (not maybePop) so canPop:false does not re-enter.
Future<void> _attemptBackRouted(_ChatFlowPageState s) async {
  final AppStrings strings = s._strings;
  // 🔴 Card FB-7 — in selection mode back leaves the MODE, not the page, and
  // is checked FIRST: the two forks below ask 「really leave this screen」,
  // which is not what a back press inside a selection is asking.
  if (s._selection.active) {
    s._selection.exit();
    return;
  }
  // 🔴 PA-4 / §5-2 close gesture: 「系统返回键 ⇒ 先收编辑面，再走既有序列」
  // ("system back key ⇒ collapse the edit face first, THEN walk the
  // existing sequence").
  // REDESIGN-PLAN §6.4's sequence is collapse panel/overlay (收面板/弹层) →
  // leave instance list (退实例列表) → root-level exit (根级退出), and
  // the sheet is an 「overlay」 (弹层) — so it goes in FRONT, exactly like the selection
  // mode above. Collapse preserves the draft (SUP-5); the confirm-discard
  // fork below still guards the NEXT back press if the draft is unsent.
  if (s._sheetOpen) {
    _collapseSheetRouted(s);
    return;
  }
  final ChatBackKind kind = chatBackKind(
    isRecording: s.controller.isRecording,
    hasUnsentBuffer: s._hasUnsentBuffer,
  );

  if (kind == ChatBackKind.stopRecording) {
    // pttUp = stop + keep path. Never pttCancel (silent drop). Stay here.
    await s.controller.pttUp();
    if (!s.mounted) return;
    s._toast(s.context, strings.recordingStoppedKept);
    return;
  }

  if (kind == ChatBackKind.confirmDiscard) {
    final bool? discard = await showDialog<bool>(
      context: s.context,
      builder: (BuildContext ctx) => AlertDialog(
        backgroundColor: FlowMicColors.surface,
        content: Text(
          strings.discardUnsentConfirm,
          style: TextStyle(color: FlowMicColors.t1, fontSize: 14),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(strings.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              strings.discardUnsentAction,
              style: TextStyle(color: FlowMicColors.red),
            ),
          ),
        ],
      ),
    );
    if (discard != true || !s.mounted) return;
  }

  // 🔴 0.3.43 Q6 — `onBack?.call()` STOOD HERE and has MOVED, not gone. It now
  // runs in [_runLeaveCleanupAfterPopRouted], off the `didPop == true` callback
  // that this very `pop()` fires. The reason is that the iOS swipe leaves by a
  // route the page never sees: with the cleanup here, the header ← would
  // disconnect and the gesture would not — one behaviour with two authors, and
  // one of them silently missing. ONE site now serves the header ←, the system
  // back, the swipe and the post-discard exit.
  //
  // ⚠️ The ORDER changed with it — cleanup AFTER the pop instead of before —
  // and that is safe here and only here: `onBack` is a plain callback
  // (production: the transport disconnect) that needs nothing on screen. The
  // `mounted` guard below always protected the `pop`, never the callback.
  if (!s.mounted) return;
  Navigator.of(s.context).pop();
}
