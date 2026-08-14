// SPEC-REF:
//   owner 2026-08-01 real-device ruling + lead's synthesis (CLAUDE.md memory
//     flowmic-transient-notice-lifecycle.md): a banner's lifecycle must match
//     the lifecycle of the FACT it states — EVENT-type (「something just
//     happened」) auto-hides after a few seconds (+ stays manually
//     dismissible); STATE-type (「currently in some state」) stays up until
//     the state itself clears, never on a timer. The literal bug report:
//     「没有听到语音」 (no voice heard) stayed up looking like a live block long
//     after the utterance that produced it had already ended.
//
// 窗口C-5. Two unrelated things live in this file, for ONE reason (800-line
// cap):
//
// (1) NEW — [reconcileBannerAutoHideRouted]: arms/re-arms/cancels one Timer
//     per EVENT-type banner surface (see [_autoHideBannerKeys]) every time
//     [ChatController.notifyListeners] fires (the override lives in
//     chat_controller.dart, right next to `notifyUi` for the same
//     `@protected`-visibility reason chat_notices.dart §2 documents).
//
// (2) VERBATIM MOVE — [disposeRouted] is chat_controller.dart's OLD
//     `dispose()` BODY, character-for-character, MINUS the trailing
//     `super.dispose()` (which cannot move: `super` is only reachable from
//     inside the class's own method — the identical constraint chat_notices.dart
//     already documents for why `notifyListeners` needs a `notifyUi` wrapper
//     instead of being called directly from a part file). It moved here —
//     purely to buy the ~26 lines (1) needed: chat_controller.dart sat AT the
//     800-line cap (doc 15 G-20) before this card, so the two new Timer-tracking
//     fields + the `notifyListeners` override could not be added without
//     freeing room first. It also now cancels the two new Timer/last-seen maps
//     — a live-timer leak otherwise, the same shape as the `DeliveryOutbox`
//     leak 窗口B3-2b found while grepping this exact method.
//
// 🔴 Diff discipline for (2): nothing in [disposeRouted]'s body differs from
// the original `dispose()` beyond the four lines cancelling the banner timers
// (marked below) and the removed `super.dispose()` call. Any other diff is a
// bug.
//
// (3) VERBATIM MOVE — [pttCancelRouted] / [onInterimRouted] are
//     `ChatController.pttCancel()` / `._onInterim()`'s old bodies,
//     character-for-character, with only the two mechanical edits every part
//     file in this family makes (explicit `c` receiver;
//     `notifyListeners()` → `c.notifyUi()`, `@protected`). Moving (1) and (2)
//     alone left the file 7 lines over the 800 cap; these two were the
//     smallest self-contained bodies left that did not require touching
//     chat_utterance.dart or chat_notices.dart (out of this card's file
//     ownership); [loadSendPolicyRouted] joined them for the same reason —
//     798 lines left only 2 of slack, too thin to trust. **Any diff beyond
//     the two mechanical edits is a bug.**

part of 'chat_controller.dart';

/// How long an EVENT-type banner stays up, once it stops CHANGING, before it
/// hides itself. Owner's real-device ask was "3-5 seconds"; the midpoint is picked
/// so there is slack on both sides without the exact number mattering. Public
/// (no leading `_`) so tests can name it instead of hard-coding a magic
/// duration — same shape as `AiComposeController.kWatchdog`.
const Duration kBannerAutoHideAfter = Duration(seconds: 4);

/// The EVENT-type banner ids this reconciler owns — every one of them
/// describes a PAST attempt/utterance/run, never a live condition, and every
/// one was already `dismissible: true` in banner_queue.dart for exactly that
/// reason (see the per-banner comments there — this card is what makes good
/// on the "past event" half of that reasoning). Mirrors [BannerIds] 1:1 for
/// the surfaces reachable from [ChatController].
///
/// 🔴 [BannerIds.link] (live connection truth — self-clears, never
/// dismissible), [BannerIds.outboxPending] (owner ruling: non-dismissible,
/// self-clears at N=0 — 窗口B3-2b), [BannerIds.outboxTerminal] (frozen for
/// 窗口C-5 — G-12 queue freeze / registered for the lead, see the delivery
/// report) and 🔴 [BannerIds.pcBusy] (卡 L7 — 「another phone is currently
/// connected to this PC」, true during the busy period, disappears the
/// instant it clears; `PttSession.pcBusy` is its sole writer, docs/rebuild/15
/// §2.5d) are DELIBERATELY absent. All four describe a CURRENT state, not a past
/// event, and none of them has (or should grow) a per-controller `dismiss`
/// this reconciler could wire up — that absence is what keeps them immune to
/// this file by construction, not just by omission from this list.
const List<String> _autoHideBannerKeys = <String>[
  BannerIds.autoStop,
  BannerIds.sttStall,
  BannerIds.utteranceCompose,
  BannerIds.composeSend,
  BannerIds.imageSend,
  BannerIds.aiCompose,
];

/// [key]'s current face: the value that decides whether this is a FRESH
/// occurrence (null ⇒ absent), and the dismiss it should fire once its window
/// elapses — the SAME callback banner_queue.dart's ✕ already fires, so an
/// auto-hide and a manual dismiss are indistinguishable to everything
/// downstream (the queue, the store, the row).
({Object? value, void Function() dismiss}) _autoHideFace(
  ChatController c,
  String key,
) => switch (key) {
  BannerIds.autoStop => (
    value: c._autoStopped ? true : null,
    dismiss: c.dismissAutoStopped,
  ),
  BannerIds.sttStall => (value: c._sttStalled, dismiss: c.dismissSttStalled),
  BannerIds.utteranceCompose => (
    value: c._utteranceFailure,
    dismiss: c.dismissUtteranceFailure,
  ),
  BannerIds.composeSend => (
    value: c.sendFailure,
    dismiss: c.dismissSendFailure,
  ),
  BannerIds.imageSend => (
    value: c.imageFailure,
    dismiss: c.dismissImageFailure,
  ),
  BannerIds.aiCompose => (value: c.aiFailure, dismiss: c.dismissAiFailure),
  _ => (value: null, dismiss: () {}),
};

/// Runs on EVERY [ChatController.notifyListeners] tick (see the override in
/// chat_controller.dart) — six map lookups, cheap enough to not need
/// throttling.
///
/// The whole contract in three branches:
///   · gone (value null) ⇒ drop any timer — nothing left to hide (the ✕, a
///     fresh pttDown, or a PRIOR auto-hide already cleared the source);
///   · unchanged since the last tick ⇒ leave a running timer alone. The
///     amplitude meter alone fires notifyListeners ~10x/s while recording;
///     without this check every one of those ticks would restart the window
///     and an unrelated stall banner could never hide while the mic stays
///     open — this exact regression is the card's second reverse-control
///     (delivery report);
///   · anything else is a FRESH occurrence ⇒ (re)arm the FULL window. This is
///     also how 「hidden is not lost」 holds: a banner only ever reaches this branch after
///     its value passed back through null — `pttDown` resets
///     `_autoStopped`/`_sttStalled` itself, and the LLM/send/image failures
///     reach null only through the dismiss this same timer fires — so the
///     NEXT occurrence always gets its own full window, never a stolen one.
void reconcileBannerAutoHideRouted(ChatController c) {
  for (final String key in _autoHideBannerKeys) {
    final ({Object? value, void Function() dismiss}) face = _autoHideFace(
      c,
      key,
    );
    if (face.value == null) {
      c._bannerAutoHideTimers.remove(key)?.cancel();
      c._bannerLastSeen.remove(key);
      continue;
    }
    if (c._bannerLastSeen.containsKey(key) &&
        c._bannerLastSeen[key] == face.value) {
      continue; // unchanged since the last tick — the running timer stays put
    }
    c._bannerLastSeen[key] = face.value;
    c._bannerAutoHideTimers.remove(key)?.cancel();
    c._bannerAutoHideTimers[key] = Timer(kBannerAutoHideAfter, face.dismiss);
  }
}

/// VERBATIM MOVE of `ChatController.dispose()`'s old body — see the file
/// header for the two permitted diffs (the banner-timer cancellation, marked
/// below, and the removed trailing `super.dispose()`, which
/// chat_controller.dart's thin wrapper now calls itself).
Future<void> disposeRouted(ChatController c) async {
  // 窗口C-5 NEW: cancel every armed auto-hide timer — a torn-down controller
  // must not go on firing dismiss callbacks into a dead store, the same shape
  // as the DeliveryOutbox leak 窗口B3-2b found in this exact method.
  for (final Timer t in c._bannerAutoHideTimers.values) {
    t.cancel();
  }
  c._bannerAutoHideTimers.clear();
  c._bannerLastSeen.clear();
  AlbumAway.instance.removeListener(c._onAlbumAwayChanged);
  c.session.pcPresence.removeListener(c._onPcPresenceChanged); // RV-92
  c.session.pcBusyListenable.removeListener(c.notifyUi); // 卡 L7
  c._polishSkippedEntryIds.clear();
  c._sessionLostTimer?.cancel();
  c.recording.dispose();
  c.aiCompose.dispose();
  // 🔴 卡 F3 缺陷① (second leak, same timer) — `utteranceCompose.dispose()` had
  // NO PRODUCTION CALLER either, exactly like `DeliveryOutbox.dispose()` two
  // lines below. The line above releases the BUFFER run's watchdog; the
  // UTTERANCE run's 45 s watchdog (`UtteranceComposeController.kWatchdog`) was
  // left armed, so a controller torn down mid-run went on to fire `_onWatchdog`
  // → `abort` → `ucFailed` into a disposed ChangeNotifier. Found by grep while
  // fixing the double-press leak, not by a symptom.
  c.utteranceCompose.dispose();
  // v0.2.8 — release the inject:result watchdog (see ManualDelivery.dispose).
  c.delivery.dispose();
  // RCA-v3 — release the progress bar's auto-clear timer + notifier.
  c.imageSend.dispose();
  // 窗口B3-2b — REAL LEAK found while grepping this card's façades:
  // `DeliveryOutbox.dispose()` (cancels every armed 45 s item watchdog) had NO
  // production caller, so a torn-down controller left live timers firing into
  // a dead store. One line, same shape as every collaborator above it.
  c.outbox.dispose();
  await c._aiComposeSub?.cancel();
  await c._refinedSub?.cancel();
  await c._amplitudeSub?.cancel();
  await c._finalSub?.cancel();
  await c._interimSub?.cancel();
  await c._injectSub?.cancel();
  await c._focusSub?.cancel();
  await c._autoStoppedSub?.cancel();
  await c._sttStalledSub?.cancel();
  await c._fsmSub?.cancel();
  c.favorites.dispose();
}

/// 窗口C-5 test-only escape hatch. `AutomatedTestWidgetsFlutterBinding`
/// (`testWidgets`) asserts NO Timer is pending the instant its widget tree is
/// torn down — send_retry_banner_test.dart already has the identical problem
/// for `ManualDelivery`'s 20 s inject:result watchdog (`releaseWatchdogs`,
/// called "after the assertions of any test that actually taps resend"), for
/// the same reason: `addTearDown` runs AFTER that check, not before. A test
/// that leaves one of the six tracked banners showing (never dismissed, never
/// elapsed) at its own end needs this. No production caller — the app's
/// widget tree is never torn down while the controller outlives it the way a
/// test's teardown does; this is checked in the delivery report, not grepped
/// for a caller, for exactly that reason.
@visibleForTesting
void debugCancelBannerAutoHideTimers(ChatController c) {
  for (final Timer t in c._bannerAutoHideTimers.values) {
    t.cancel();
  }
  c._bannerAutoHideTimers.clear();
  c._bannerLastSeen.clear();
}

/// VERBATIM MOVE of `ChatController.pttCancel()`'s old body (see the file
/// header (3)). Swipe-up cancel: the utterance never completed → NO row is
/// built (§4.0 A).
Future<void> pttCancelRouted(ChatController c) async {
  await c.session.pttCancel();
  c._activeClientId = null;
  c._liveText = '';
  c.recording.stop();
  c.recording.reset();
  c.notifyUi();
}

/// VERBATIM MOVE of `ChatController._onInterim()`'s old body (see the file
/// header (3)).
void onInterimRouted(ChatController c, SttInterim p) {
  if (!c.hasLiveDraft) return;
  c.recording.observeSegment(p.segmentIdx);
  // N1-B2: the draft shows the spans that are NOT already on a row. Reading the
  // whole `joined` here would redraw every settled segment underneath its own
  // row for the rest of the recording — the same words twice, one of them
  // labelled 「transcribing」.
  c._liveText = c.session.segments.unsettledJoined;
  c.notifyUi();
}

/// VERBATIM MOVE of `ChatController.loadSendPolicy()`'s old body (see the
/// file header (3)). Hydrate the persisted policy on boot. Never throws — an
/// unreadable pref leaves the documented default (direct).
Future<void> loadSendPolicyRouted(ChatController c) async {
  final SendPolicy stored = await c.localPrefs.sendPolicy();
  if (stored == c._sendPolicy) return;
  c._sendPolicy = stored;
  c.notifyUi();
}

/// VERBATIM MOVE of `ChatController.setSendPolicy()` / `toggleSendPolicy()`'s
/// old bodies — same 800-line-cap reason as [loadSendPolicyRouted], and they
/// are that method's own family (one pref, one writer, one place to read).
Future<void> setSendPolicyRouted(ChatController c, SendPolicy next) async {
  if (c._sendPolicy == next) return;
  c._sendPolicy = next;
  c.notifyUi();
  await c.localPrefs.setSendPolicy(next);
}

Future<void> toggleSendPolicyRouted(ChatController c) => c.setSendPolicy(
      c._sendPolicy == SendPolicy.manual ? SendPolicy.direct : SendPolicy.manual,
    );
