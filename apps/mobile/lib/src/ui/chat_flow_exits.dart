// The two ways this screen LEAVES ITSELF, and the sentence each one owes the
// user on the way out.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as chat_flow_composer.dart / chat_flow_entry_actions.dart /
// chat_flow_selection.dart: `chat_flow_page.dart` hit the 800-line cap
// (`verify/lint/file-size.mjs` SRC_MAX) when fix-001 added the second exit, and
// the repo's standing move at that cap is a STRUCTURAL SPLIT, never deleting
// the evidence in the comments (CLAUDE.md, 0.2.52: "structural splitting per
// this repo's established practice, not deleting evidence" — 按仓里成例做结构
// 拆分而不是删证据). Behaviour moves character-for-character; the latch
// FIELDS stay on the state (a `part` cannot add fields), and the page keeps a
// one-line delegator for each so every call site is where it was.
//
// 🔴 DIFF DISCIPLINE: both bodies below are the previous methods moved verbatim.
// **Any other difference in the diff is a bug.**
//
// ── WHY TWO OF THEM, AND WHY THEY MAY NEVER BE MERGED ────────────────────
// They answer different questions and produce different sentences:
//   · 「与电脑的连接断了」("the connection to the computer dropped") — the
//     link died under us (owner 2026-07-26 ②);
//   · 「这台电脑被别人用着」("this computer is being used by someone else") —
//     the link is FINE and we are simply not welcome (owner 2026-08-11 iron
//     rule: 「有且只能有一个手机连上来」 — "exactly one phone may be
//     connected, no more").
// Two facts, two latches, two sentences. Folding them into one flag would let
// whichever fired first silence the other — a user bounced for occupancy and
// then genuinely disconnected would be told nothing the second time. That is
// this repo's headline bug shape (one value answering two questions) applied
// to an exit.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5d
//     (【retired 2026-08-11】— the banner this file's second exit replaced)
//   session/pc_busy.dart ([PcBusyTracker] — the bucketing rule, unchanged)

part of 'chat_flow_page.dart';

/// owner 2026-07-26 ②: the controller gave up on the link. Leave the
/// transcription page for the connections list and SAY WHY — an unexplained
/// navigation reads as the app losing its place.
///
/// 🔴 WHAT `sessionLost` MEANS CHANGED ON 2026-08-19 (owner ruling 4), and this
/// function did not. It used to mean 「10 秒断开」 ("ten seconds disconnected");
/// it now means 「重试预算花光了」 ("the retry budget is spent") — the page stays
/// through the ten seconds AND through `kLinkRetryBudget` dial
/// attempts, and only the last of those failing raises the flag. The exit is
/// unchanged because the exit was never the disputed part: what the owner
/// reported (0.3.9 handoff §7-6) was leaving too EARLY, with no machine still
/// trying, not leaving at all. The sentence it shows moved with the meaning —
/// see [AppStrings.sessionLostToast].
void _maybeLeaveOnSessionLostRouted(_ChatFlowPageState s) {
  if (!s.controller.sessionLost || s._sessionLostHandled) return;
  s._sessionLostHandled = true;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!s.mounted) return;
    ScaffoldMessenger.of(s.context).showSnackBar(
      SnackBar(content: Text(s._strings.sessionLostToast)),
    );
    Navigator.of(s.context).popUntil((Route<dynamic> r) => r.isFirst);
  });
}

/// 🔴 fix-001 / owner's 2026-08-11 iron rule — 「出现胶囊窗口的时候，**有且只能
/// 有一个手机连上来**」("when the capsule window appears, **exactly one phone,
/// no more, may be connected**"). The capsule is held by ANOTHER phone, so
/// this one may not sit on the transcription screen at all: leave for the
/// connections list and SAY WHY.
///
/// The FACT is read through [PttSession.pcBusyOnScreen], never the raw flag —
/// the same bucketing rule the retired banner used (G-20/RV-91: `ChatController`
/// is a singleton that outlives any one instance's screen), so a phone bounced
/// off machine A cannot yank the user out of machine B's screen.
///
/// The judgement itself is NOT made here and must not be: 「这台电脑被别人用着」
/// ("this computer is being used by someone else") has exactly one source of
/// truth, the server's named `PC_BUSY` on the `mobile:reconnect` ack
/// (`ptt_reconnect_ack.dart` `onRejected`). Inferring it from a delivery
/// failure instead — `INJECT_NOT_IN_ROOM` and friends have half a dozen other
/// causes — would eject the user on a plain outage.
///
/// ⚠️ This REPLACES `BannerIds.pcBusy` (15 册 §2.5d, retired 2026-08-11). The
/// banner said 「先记录，等对方退出再投」("record for now, deliver once the
/// other one leaves") and kept the user here; that is the behaviour owner
/// overruled. There is deliberately no banner left to fall back on — a screen
/// you are being removed from cannot also carry a persistent notice explaining
/// why you are staying.
///
/// ── HOW IT IS DRIVEN (both halves matter, and the page keeps only pointers) ──
/// · ON THE EDGE — `chat_flow_page.initState` registers this on the CONTROLLER,
///   which already forwards `session.pcBusyListenable` into its own notify
///   (`chat_transient_banner_timers.dart` wires `pcBusyListenable → notifyUi`).
///   So it rides the exact edge the retired banner rode; nothing new is polled.
/// · ON ENTRY — and it is ALSO called once directly from `initState`. The
///   refusal can already be true when this page is pushed (the phone was bounced
///   while the instance list was open), and a latch that only ever fires on a
///   CHANGE would miss precisely that case. That is the "pushed state with no
///   pull" (推送状态没有拉取) structural defect this repo has paid for
///   repeatedly (0.2.x wrap-up §4-A): a fact that can only be PUSHED is
///   invisible to anyone who arrives late.
void _maybeLeaveOnCapsuleTakenRouted(_ChatFlowPageState s) {
  if (s._capsuleTakenHandled) return;
  if (!s.controller.session.pcBusyOnScreen(
    s.controller.session.connectedInstanceId,
  )) {
    return;
  }
  s._capsuleTakenHandled = true;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!s.mounted) return;
    ScaffoldMessenger.of(s.context).showSnackBar(
      SnackBar(content: Text(s._strings.capsuleTakenNotice)),
    );
    Navigator.of(s.context).popUntil((Route<dynamic> r) => r.isFirst);
  });
}

/// owner 2026-08-20 — the PC pressed 断开 (or 取消配对) on THIS phone. The third
/// exit, and the only one whose fact arrives as a NAMED EVENT rather than an
/// inference: the server says `mobile:released` immediately before it closes
/// the socket (`docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md`).
///
/// 🔴 WHY NOT LET THE SESSION-LOST PATH HANDLE IT. Without this, the closed
/// socket walks into `_watchSessionLoss`: a 10-second window, then a retry
/// budget the ladder will never spend (the released handler stopped it), then
/// [AppStrings.sessionLostToast] —「多次重连未成功」. Ten seconds late, and a
/// SENTENCE ABOUT A NETWORK FAILURE for something a person did on purpose. The
/// whole point of the event is that the phone finally knows the difference; an
/// exit that then says the generic sentence would throw that knowledge away.
///
/// Rides [PcReleaseCooldown.tick] directly (registered in `initState`, plus the
/// one on-entry call — same pushed-state-needs-a-pull rule as the capsule-taken
/// exit above). Bucketed through [SessionScope.key], so a singleton controller
/// serving another machine's screen ignores it (RV-91).
///
/// The sentence splits on [PcReleaseCooldown.latchedRevoked] because the next
/// action splits: a disconnect is waited out ([ChatStrings.pcReleasedNotice],
/// with the server's own seconds), a revoke can only be re-paired
/// ([ChatStrings.pcReleasedRevokedNotice] — no countdown, nothing to count to).
void _maybeLeaveOnPcReleasedRouted(_ChatFlowPageState s) {
  if (s._pcReleasedHandled) return;
  final cooldown = s.controller.session.releaseCooldown;
  if (!cooldown.isOnScreen(s.controller.session.scope.key)) return;
  s._pcReleasedHandled = true;
  final bool revoked = cooldown.latchedRevoked;
  // ceil, floor 1: a wait of 900 ms must not render as 「0 秒后」 — a zero-second
  // wait the button then refuses would make the sentence a liar for one second.
  final int rawSecs = ((cooldown.latchedRemaining()?.inMilliseconds ?? 0) / 1000).ceil();
  final int secs = rawSecs < 1 ? 1 : rawSecs;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!s.mounted) return;
    ScaffoldMessenger.of(s.context).showSnackBar(
      SnackBar(
        content: Text(
          revoked
              ? s._strings.pcReleasedRevokedNotice
              : s._strings.pcReleasedNotice(secs),
        ),
      ),
    );
    Navigator.of(s.context).popUntil((Route<dynamic> r) => r.isFirst);
  });
  // 🔴 NOT redundant, and the line the first version shipped without.
  // `addPostFrameCallback` WAITS for a frame and schedules none itself — and
  // this exit's edge is the only one of the three that arrives from the SOCKET
  // (a ValueNotifier tick) rather than from a controller notify that rebuilds
  // widgets. Nothing here marks anything dirty, so on an idle page there is no
  // frame coming: the callback above would sit queued until something ELSE
  // animates — measured in the widget rig as an eject that only ran at
  // teardown, `mounted == false`, page still standing after three pumps. The
  // other two exits do not need this line because their edges inherently
  // schedule a build; this one must bring its own frame.
  WidgetsBinding.instance.scheduleFrame();
}
