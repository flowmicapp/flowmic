// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §3 P-3 (ONE banner slot, priority-ordered)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5 (UI wording /
//     界面用词)
//
// WHICH live sources feed the chat page's one banner slot — moved out of
// chat_flow_page.dart (800-line cap) in window B3-2b, VERBATIM apart from reading
// its inputs off [controller] instead of off the page's `controller` field.
//
// 🔴 Nothing was changed in the move: same sources, same order, same dismiss
// callbacks. **Any diff beyond 「moved」 + 「the two queue sources below」 is a
// bug.** The split is also the right seam on its own: `buildChatBanners` is a
// pure function over primitives (deliberately, so severity is unit-testable),
// and THIS is the adapter that says where each primitive comes from — a
// different job from rendering, and the one that grows every time the app gains
// a thing that can go wrong.

import '../session/chat_controller.dart';
// CR-3: `continuousCapturingOffline` is an EXTENSION member (ptt_link_loss.dart,
// part of this library), so the library has to be in scope for it to resolve.
// The dependency itself is not new — two fields below already read off
// `controller.session`.
import '../ptt/ptt_session.dart';
import '../settings/app_strings.dart';
import '../signaling/album_away.dart';
import 'banner_queue.dart';
import 'mic_permission_banner.dart';

/// Map the live chat state onto the banner queue.
///
/// [onRetrySendFailure] is null when there is nothing to retry — the banner then
/// stays a plain notice (RV-15: never a button that guesses at a row).
BannerQueue chatBannerSources({
  required ChatController controller,
  required AppStrings strings,
  required void Function()? onRetrySendFailure,
  /// Card RC-1b — opens the pending-recovery screen. Optional because the
  /// banner adapter is exercised by four tests that have no Navigator; a null
  /// here means the retained-audio banner keeps the face it has always had.
  void Function()? onOpenPendingRecovery,
}) {
  final BannerQueue queue = _liveSources(
    controller: controller,
    strings: strings,
    onRetrySendFailure: onRetrySendFailure,
    // 🔴 THE GATE, AND IT IS A MEASUREMENT RATHER THAN A GUESS: the recovery
    // queue publishes what it found on disk, and `hasKeptAudio` is that value
    // asked one question. A tap target attached unconditionally would open an
    // empty page on every phone that has never had an outage.
    onOpenPendingRecovery:
        controller.backfill.progress.value.hasKeptAudio
            ? onOpenPendingRecovery
            : null,
  );
  // card U2 — the mic-permission flow, read straight off the session the same way
  // `ladderReconnecting` / `pcBusy` are. Pushed AFTER the queue's own entries
  // so an equally-blocking live link-drop keeps the slot (sttStall's FIFO
  // reasoning); the whole face→banner mapping lives in mic_permission_banner.
  pushMicPermissionBanner(
    queue,
    flow: controller.session.micPermission,
    strings: strings,
  );
  // 🔴 Card PAIR-SUCCESS MOVED OFF THIS QUEUE 2026-08-26 (owner). It is now a
  // CENTRED, self-fading panel (ui/pairing_success_toast.dart), for three
  // reasons written out in that file. The one that belongs here: this slot
  // renders exactly ONE entry and this fact was pushed LAST, so any other
  // queued banner kept the slot. Winning that contest was never the fix —
  // a pairing confirmation and a live fault are not competing for the same
  // piece of screen, and treating them as if they were is what hid it.
  return queue;
}


BannerQueue _liveSources({
  required ChatController controller,
  required AppStrings strings,
  required void Function()? onRetrySendFailure,
  required void Function()? onOpenPendingRecovery,
}) => buildChatBanners(
  onOpenPendingRecovery: onOpenPendingRecovery,
  connection: controller.connection,
  autoStopped: controller.autoStopped,
  // 🔴 fix-026 — WHY it stopped. Without this ONE line the whole chain
  // (server table → wire → stream → controller → selector) still ends at the
  // five-minute sentence: this file is 「where each primitive comes from」, so a
  // primitive nobody reads from here does not exist as far as the user is
  // concerned. Grep-able consumer of `ChatController.autoStopReason`.
  autoStopReason: controller.autoStopReason,
  albumAway: AlbumAway.instance.isOpen,
  ladderReconnecting: controller.session.reconnect.reconnecting.value,
  // 🔴 B4 (2026-08-18) — THE PRODUCTION CALLER of ReconnectCoordinator.kickNow's
  // manual arm. `isRunning` is the whole gate: a ladder stopped on a dead token
  // belongs to the re-pair flow, and offering 「立即重连」 there would be a button
  // that cannot succeed. kickNow re-checks it again at fire time — this decides
  // whether the AFFORDANCE is honest, that decides whether the DIAL is.
  onReconnectNow: controller.session.reconnect.isRunning
      ? () => controller.session.reconnect.kickNow(reason: 'user-banner')
      : null,
  strings: strings,
  // 🔴 Card CR-3 — THE PRODUCTION READER of `continuousCapturingOffline`.
  // Without this one line the whole chain (link-loss edge → kept-open mic →
  // retention layer → getter) still ends at 「Link down · content buffered」,
  // and a user whose meeting is being recorded offline has no way to know it.
  // This file is 「where each primitive comes from」, so a primitive nobody
  // reads from here does not exist as far as the user is concerned — the same
  // sentence fix-026 earned one field above.
  continuousOffline: controller.session.continuousCapturingOffline,
  // 🔴 Card CR-9 — THE PRODUCTION READER of `ContinuousCapTimer.warningTicket`.
  // Without this line the ceiling still stops the recording on time and the
  // user gets no warning at all: the timer fires, the ticket goes up, and
  // nothing on any screen reads it. Same sentence CR-3 earned one field above —
  // this file is 「where each primitive comes from」, so a primitive nobody reads
  // from here does not exist as far as the user is concerned.
  continuousCapWarning: controller.session.capTimer.warningTicket != 0,
  onDismissContinuousCapWarning: controller.session.capTimer.dismissWarning,
  // GA-03: a PTT press that produced no transcript at all
  // (15 s net / terminal stt:error) — never silent.
  sttStalled: controller.sttStalled,
  // GA-01: the LLM leg failed, so what the user just said
  // was NOT delivered — said out loud, never swallowed.
  utteranceFailure: controller.utteranceFailure,
  // T-3a ③: a send that did not happen is loud, never eaten.
  sendFailure: controller.sendFailure,
  // T-3b ④: an LLM failure is never dressed up as success.
  aiFailure: controller.aiFailure,
  // T-4: a picture that did not reach the PC says why —
  // permission, size or link, each with its own fix.
  imageFailure: controller.imageFailure,
  // window B3-2b — THE QUEUE'S TWO SURFACES. Both were produced and read by
  // nobody until this line existed; `delivery_outbox.dart` said so in as many
  // words at its own definition (「这个句子产出了没有人显示」/ "this sentence
  // gets produced and nobody displays it").
  //
  // owner ruled the count is NON-BLOCKING observability — 「不管时间多久全部都要
  // 投递」("no matter how long it takes, all of it must be delivered"), so
  // nothing here may gate an action; the banner only says how many
  // are still owed. Its severity is `info` precisely so it can never displace a
  // real fault (it loses every priority contest and waits behind 「还有 N 条」
  // / "N more remaining").
  // 🔴 Card UX2-2 — THE NOTICE, NOT THE BARE COUNT. `controller.outboxPending`
  // (the number) is still what everything else reads; the banner needs the two
  // facts that go with it, or it says 「还有 1 条待投递」 after every healthy press
  // — which is what 0.3.75 did. Gate and rationale: `outbox_notice_gate.dart`.
  outboxPending: controller.outboxPendingNotice,
  // 🔴 The `pcBusy:` argument was DELETED 2026-08-11 (fix-001). 「另一台手机正连着
  // 这台电脑」("another phone is currently connected to this computer") no
  // longer draws a banner on this screen, because the phone is no
  // longer ALLOWED on this screen (owner 2026-08-11 iron rule / 铁律; volume 15
  // §2.5d retired).
  // The same bucketed fact — `session.pcBusyOnScreen(connectedInstanceId)` — is
  // now read by `chat_flow_page._maybeLeaveOnCapsuleTaken`, which exits instead.
  // One fact, still one reader; the reader moved.
  // The queue's OWN terminals (bytes gone / overflow). A terminal with no
  // sentence is 「静默失败」("silent failure") wearing a code — this is the
  // sentence's renderer.
  outboxTerminal: controller.outboxTerminal,
  // `timelineConflict` was passed here until 0.2.27. The
  // uplink whose ack produced it is retired, so no peer can
  // overrule this phone's rows any more (see banner_queue).
  // AUD-D F6 / P1-6 (card B2-O) — THE PRODUCTION READER of
  // `RetainedAudioStore.lastNotice` (via `ChatController.retainedAudioNotice`).
  // Without this line the store's own header ("callers MUST surface these")
  // stayed answered only by a diag log line — this file is 「where each
  // primitive comes from」, so a primitive nobody reads from here does not
  // exist as far as the user is concerned (the same sentence CR-3/CR-9/fix-026
  // earned their own fields above).
  retainedAudioNotice: controller.retainedAudioNotice,
  onDismissRetainedAudioNotice: controller.dismissRetainedAudioNotice,
  onDismissAutoStop: controller.dismissAutoStopped,
  onDismissSttStalled: controller.dismissSttStalled,
  onDismissUtteranceFailure: controller.dismissUtteranceFailure,
  onDismissSendFailure: controller.dismissSendFailure,
  onDismissAiFailure: controller.dismissAiFailure,
  onDismissImageFailure: controller.dismissImageFailure,
  onDismissOutboxTerminal: controller.dismissOutboxTerminal,
  // RV-15 corrected this: resend (重发) rides ManualDelivery.reInject
  // (per row), NOT deliverText — a RE-delivery, stamped now.
  onRetrySendFailure: onRetrySendFailure,
);
