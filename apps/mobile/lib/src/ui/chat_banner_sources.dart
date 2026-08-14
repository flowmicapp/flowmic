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
}) {
  final BannerQueue queue = _liveSources(
    controller: controller,
    strings: strings,
    onRetrySendFailure: onRetrySendFailure,
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
  return queue;
}

BannerQueue _liveSources({
  required ChatController controller,
  required AppStrings strings,
  required void Function()? onRetrySendFailure,
}) => buildChatBanners(
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
  strings: strings,
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
  outboxPending: controller.outboxPending,
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
