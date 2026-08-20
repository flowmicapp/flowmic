// The link watch: what the chat page does while the connection is DOWN, from
// the first missed beat to the moment it gives up and leaves.
//
// ── WHY IT IS ITS OWN FILE ───────────────────────────────────────────────
// `chat_utterance.dart` hit the 800-line cap (`verify/lint/file-size.mjs`) when
// owner's 2026-08-19 ruling turned one function into four. The repo's standing
// move at that cap is a STRUCTURAL SPLIT with the bodies moved verbatim, never
// deleting the evidence in the comments (CLAUDE.md, 0.2.52). This family was
// also the least utterance-shaped thing in that file: nothing here is about a
// spoken row.
//
// 🔴 DIFF DISCIPLINE: the four functions below are moved character-for-character
// out of chat_utterance.dart. **Any other difference in the diff is a bug.**
//
// ── THE RULE THIS FILE IMPLEMENTS, AND WHY IT CHANGED ────────────────────
// owner 2026-07-26 ② gave the page a 10 s patience and then sent the user back
// to the connections list. 0.3.9's on-device pass (handoff §7-6) measured what
// that actually bought: B1 (「网络回来了」) and B4 (the banner's 「立即重连」)
// were both built to shorten a drop, and BOTH could only ever act inside those
// first 10 s — after them the ladder was stopped and the page was gone. Every
// outage longer than that ended in 「退出之后再进来才能连接起来」 ("you have to
// leave and come back in before it connects"), which is what the owner reported
// in the first place.
//
// owner 2026-08-19 (ruling 4, `docs/decisions/2026-08-19-owner-phase2-four-rulings.md`):
// stay on the page, retry `kLinkRetryBudget` times, then return
// to the list. So expiry no longer ends the session — it opens a budget:
//
//   window (10 s, unchanged) → budget (N dial attempts) → leave, and say why
//
// Neither end of the original argument is abandoned. 「停在转录页无限重试」
// ("staying stuck on the transcription page retrying forever") is still
// rejected: the budget is finite. And the exit still explains itself
// ([AppStrings.sessionLostToast], reworded with the rule).
//
// ⚠️ A COUNT, NOT A LONGER TIMER, and the difference is what the user sees: the
// link banner keeps saying 「正在重连」 with a button that works, and the thing
// that ends the wait is a real attempt failing rather than a clock running out.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (the reconnect ladder itself)
//   docs/strategy/2026-08-18-039-connection-stability-window-handoff-report.md §7-6
//   apps/mobile/test/chat_link_retry_budget_test.dart (the budget's own tests)

part of 'chat_controller.dart';

/// owner 2026-08-19: how many dial attempts the page spends before it gives up
/// and returns to the connections list.
///
/// Library-level rather than a member of [ChatController] for one reason: the
/// number and the code that spends it must not be able to drift apart, and the
/// controller is already at the source cap — a constant parked there would have
/// been the first thing pushed out by the next unrelated field.
///
/// 🔴 3 → 5, owner 2026-08-20 (the same ruling that made a PC-initiated
/// disconnect terminal:「其它都可以重试5次，重试间隔要一次比一次长」—
/// `docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md`).
/// This supersedes the 08-19 ruling's 3.
///
/// ⚠️ The「间隔一次比一次长」half is NOT implemented here, because it already
/// exists: the attempts this budget counts are the LADDER's own rungs, and
/// `ReconnectCoordinator._backoffFor` doubles each one (1 s → 2 s → 4 s → 8 s
/// → 16 s, 30 s cap). A second backoff at this layer would be two clocks
/// pacing one dial. What five attempts buys over three is therefore not two
/// more taps — it is the ladder reaching its longer rungs before the page
/// concludes nobody is answering (≈31 s of dialling instead of ≈7 s).
const int kLinkRetryBudget = 5;

/// The budget's whole state, in one object because it is one fact: 「这次掉线
/// 我们还剩几次机会」 ("how many chances are left on THIS outage").
///
/// ⚠️ [seen] is not bookkeeping, it is the difference between counting
/// TRANSITIONS and counting CALLS. [_watchSessionLoss] is re-entered with an
/// unchanged state from two directions — `onFsmChangeRouted` fires for every
/// snapshot (the session half moves on its own) and `onAlbumAwayChangedRouted`
/// calls it by hand — so a version without this field spends the entire budget
/// inside one dial and throws the user out while an attempt is still in flight.
/// Pinned by 「re-entering with the SAME state is not an attempt」; that test was
/// observed red with this field removed.
class LinkRetryBudget {
  /// True from the moment the window expires until the link is back or the
  /// budget is spent. It means 「我们在花预算」, never 「连不上」 — that one is
  /// [ChatController.sessionLost].
  bool spending = false;

  /// Attempts observed since [spending] went true. It counts attempts, NOT their
  /// causes: a rung the ladder timed out into and a rung the user asked for with
  /// 「立即重连」 count the same. The alternative (user taps are free) lets a page
  /// nobody can reconnect stay open forever as long as somebody keeps tapping.
  int attempts = 0;

  /// The connection state already accounted for.
  ConnectionState? seen;

  void reset() {
    spending = false;
    attempts = 0;
    seen = null;
  }
}

/// Arm the give-up window on ANY not-connected state; disarm the moment the
/// link is back. While the window runs, the reconnect ladder keeps retrying (a
/// blip must heal in place — GA-04's audio grace rides those early rungs).
///
/// 🔴 owner 2026-08-19 CHANGED WHAT EXPIRY MEANS. It used to stop the ladder
/// and pop the page. It now opens the retry budget
/// ([kLinkRetryBudget]): the page STAYS, the ladder keeps
/// dialling, the link banner keeps saying so — and the page leaves only once
/// that many attempts have been made and failed. Neither end of the old
/// argument is abandoned: 「停在转录页无限重试」("staying stuck on the
/// transcription page retrying forever") is still rejected, and the exit still
/// says why. What changed is that the machine keeps trying while the user is
/// looking at it, instead of after they have been sent away.
///
/// RV-60: an expected drop inside the album-away window must NOT start this
/// timer — the user is in the system picker, not abandoned. Closing the window
/// (picker returned / cap expired) re-enters here and arms a FRESH window if
/// the link is still down.
void _watchSessionLoss(ChatController c, ConnectionState conn) {
  if (conn == ConnectionState.connected) {
    c._sessionLostTimer?.cancel();
    c._sessionLostTimer = null;
    // The latch describes THIS link, not the controller's whole life. It used to
    // be set once and never cleared, and the controller is a singleton — so one
    // real loss poisoned every later visit: re-enter the chat page, and the first
    // notify (the PTT press itself) popped the user straight back to the list,
    // now disconnected too because leaving the page also leaves the room.
    // owner 2026-07-27, reproduced on the tablet after the server had died once.
    c.sessionLost = false;
    // Same reasoning, one layer down: a link that came back spent nothing. The
    // budget describes THIS outage.
    c.linkRetry.reset();
  } else if (AlbumAway.instance.isOpen) {
    c._sessionLostTimer?.cancel();
    c._sessionLostTimer = null;
  } else if (c.linkRetry.spending && !c.sessionLost) {
    _spendRetryBudget(c, conn);
  } else if (c._sessionLostTimer == null && !c.sessionLost) {
    c._sessionLostTimer = Timer(c.sessionLostAfter, () => _onSessionLost(c));
  }
}

/// One edge of the budget phase. `connecting`/`reconnecting` is an attempt
/// STARTING; anything else while the budget is already spent is that attempt
/// having FAILED.
///
/// 🔴 The order of the two tests is the whole correctness of this function: the
/// give-up test asks 「有没有一次尝试已经跑完且失败了」("has an attempt run to
/// completion and failed"), so it must never see the edge that STARTS the third
/// attempt — that edge would end the session while a dial is still in flight,
/// i.e. bounce the user off a connection that was about to succeed.
void _spendRetryBudget(ChatController c, ConnectionState conn) {
  if (conn == c.linkRetry.seen) return; // a re-entry, not a new edge
  c.linkRetry.seen = conn;
  if (conn == ConnectionState.connecting ||
      conn == ConnectionState.reconnecting) {
    c.linkRetry.attempts += 1;
    c.ucNotify();
    return;
  }
  // The same refusal `_onSessionLost` makes on the way in, re-asked: a ladder
  // that STOPPED mid-budget (auth:expired drains it — `auth_expired_handler.dart`
  // stops it by design) will never make the attempts we are waiting for, and a
  // page waiting for attempts nobody will make is a page that hangs.
  if (!c.session.reconnect.isRunning ||
      c.linkRetry.attempts >= kLinkRetryBudget) {
    _giveUpOnLink(c);
  }
}

/// The 10 s window expired with the link still down. Do NOT stop the ladder and
/// do NOT leave: from here on the page is spending [kLinkRetryBudget]
/// attempts, and the link banner (`banner_queue.dart` `_linkBanner`) already
/// renders that state with its 「立即重连」 action.
///
/// ⚠️ One case skips the budget entirely and must: a ladder that is not running
/// was stopped ON PURPOSE (a dead token — that path belongs to the explicit
/// re-pair flow, see `ReconnectCoordinator.kickNow`'s first guard). Waiting out
/// three attempts that nobody will ever make is a page that hangs, and the
/// banner's button would be a button that cannot succeed.
void _onSessionLost(ChatController c) {
  c._sessionLostTimer = null;
  if (c._conn == ConnectionState.connected) return; // healed at the wire
  if (!c.session.reconnect.isRunning) {
    _giveUpOnLink(c);
    return;
  }
  c.linkRetry.reset();
  c.linkRetry.spending = true;
  c.linkRetry.seen = c._conn;
  c.ucNotify();
}

/// Stop the ladder FIRST (its 30 s rungs would otherwise keep dialing a dead PC
/// from behind the connections list), then flag the page — it pops back to the
/// list and says why.
void _giveUpOnLink(ChatController c) {
  c.sessionLost = true;
  c.linkRetry.spending = false;
  unawaited(c.session.reconnect.stop());
  c.ucNotify();
}
