// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §3 P-3 「永不静默，但只吵一次」("never
//     silent, but only makes noise once") — every banner
//     collapses into ONE slot, priority-ordered blocking-error > degraded-warning > info, at most
//     one on screen + 「N more」expandable; §6.2 ② (home page single banner
//     slot), §6.3 (recording state)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 1 T-5
//   CLAUDE.md red line 「no silent failure」: the queue NEVER drops an error — it only stops
//     errors from STACKING. Everything below the top stays reachable through
//     [BannerQueue.all] / the overflow count, and a live blocking condition is
//     not dismissible at all.
//
// Pure Dart state: no Flutter widget import, so the whole priority / dedupe /
// overflow contract is unit-testable without a WidgetTester. The rendering is
// banner_slot.dart; the two live sources are mapped by [buildChatBanners].
//
// 🔴 Window C-5 — LIFECYCLE CONTRACT (owner's 2026-08-01 real-device session +
// CLAUDE.md memory
// flowmic-transient-notice-lifecycle.md): a banner's lifecycle must match the
// lifecycle of the FACT it states.
//   · EVENT-type (「something just happened」 — an utterance/attempt/run that is ALREADY
//     OVER) auto-hides a few seconds after it stops changing, AND stays
//     manually dismissible, AND shows again if the same fact recurs (hidden
//     is not the same as lost).
//     The literal bug: 「没有听到语音」("no speech was heard") (sttStall) stayed up looking like a live
//     block long after the utterance that produced it had already ended.
//   · STATE-type (「what state is it in right now」 — still true right now) never auto-hides;
//     it self-clears the moment the state itself changes, on no other timer.
// THIS FILE stays a pure snapshot function and does not know about time — the
// six ids below with an auto-hide Timer (`link`/`outboxPending`/
// `outboxTerminal` deliberately excluded — see there) are armed one layer up,
// in `ChatController` (session/chat_transient_banner_timers.dart), which is
// where the STATEFUL half of this contract lives.

import 'package:meta/meta.dart';

import '../session/compose_gate.dart'
    show AiComposeFailure, AiComposeOutcome, ComposeSendFailure;
import '../session/image_send_controller.dart' show ImageSendOutcome;
import '../session/outbox_failure_text.dart' show OutboxTerminal;
import '../settings/app_strings.dart';
import '../signaling/state_machine.dart';
// The C5 cross-device conflict vocabulary (timeline_conflict.dart) was deleted
// in 0.2.27 with the history uplink that produced it — see the retirement notes
// in timeline_sync.dart. Nothing here imports it any more.

/// Banner priority. DECLARATION ORDER IS THE PRIORITY ORDER (`.index` is the
/// rank) — reordering these values reorders the queue, so don't.
enum BannerSeverity {
  /// Blocking error — the user cannot proceed (link down → PTT dead, slot taken,
  /// pairing expired). A STATE-type blocking entry (the live link drop) is
  /// never auto-dismissed and never user-dismissible while the condition is
  /// live. An EVENT-type blocking entry (sttStall / a failed send / a failed
  /// AI run — the attempt is already OVER, only its NEWS is blocking) is the
  /// opposite on both counts: dismissible now, and auto-hidden a few seconds
  /// after it stops changing (Window C-5, ChatController's reconciler) — see the
  /// lifecycle contract at the top of this file.
  blocking,

  /// Degraded warning — still working, but degraded (reconnecting/buffering, the 5-min
  /// auto-stop). Dismissible when it describes a past event rather than a live
  /// condition — and, like the EVENT-type blocking entries above, also
  /// auto-hidden after a few seconds when it is one (Window C-5).
  degraded,

  /// Info — informational only.
  info,
}

/// One queued banner. [id] is the dedupe key: pushing the same id twice
/// REFRESHES the entry in place instead of stacking a duplicate.
@immutable
class BannerItem {
  const BannerItem({
    required this.id,
    required this.severity,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.onDismiss,
    this.dismissible = false,
  });

  /// Stable dedupe key (see [BannerIds]).
  final String id;
  final BannerSeverity severity;

  /// Already-localized copy (AppStrings resolves it before the push).
  final String message;

  /// Optional inline action label (e.g. take over / view instance / resend). Null = no action button.
  final String? actionLabel;

  /// Runs on the action button, or on ✕ when [dismissible] and no action label.
  final void Function()? onAction;

  /// M2: runs on ✕ when the item has BOTH an action and a dismiss affordance —
  /// the action button fires [onAction] (the fix), ✕ fires this (just close).
  /// Null keeps the legacy single-callback shape: ✕ falls back to [onAction].
  final void Function()? onDismiss;

  /// Whether the user may dismiss this entry. A LIVE blocking condition must
  /// stay false — silencing it would be exactly the swallowed error the red
  /// line forbids.
  final bool dismissible;

  /// Value equality over the visible face ONLY. [onAction] / [onDismiss] are
  /// deliberately excluded: they are closures rebuilt on every frame, so
  /// including them would make every push look like a change and defeat the
  /// dedupe.
  @override
  bool operator ==(Object other) =>
      other is BannerItem &&
      other.id == id &&
      other.severity == severity &&
      other.message == message &&
      other.actionLabel == actionLabel &&
      other.dismissible == dismissible;

  @override
  int get hashCode => Object.hash(id, severity, message, actionLabel, dismissible);

  @override
  String toString() => 'BannerItem($id, ${severity.name}, "$message")';
}

/// Stable dedupe keys for the banner sources wired so far. New sources
/// (observing / taken over / pairing expired) add a const here rather than
/// inventing a literal.
class BannerIds {
  const BannerIds._();

  /// Transport truth (disconnected/reconnecting). One id for both severities so
  /// a degrade→block transition REPLACES rather than stacks.
  static const String link = 'link';

  /// audio:auto-stopped — the server hit the 5-min hard cap (R6 P0-R3).
  static const String autoStop = 'auto_stop';

  /// PROCESSING closed with no transcript — the 15 s local safety net fired or
  /// the engine reported a terminal stt:error (GA-03).
  static const String sttStall = 'stt_stall';

  /// GA-01: the LLM leg of a translate/organize utterance failed, so what the
  /// user just SAID was not delivered. Its own id, not [aiCompose]: that one is
  /// about the buffer (nothing was lost), this one is about a delivery that did
  /// not happen — collapsing them would let one overwrite the other.
  static const String utteranceCompose = 'utterance_compose';

  /// A ComposeBand ➤ / control key that did not reach the PC (R6 T-3a ③).
  static const String composeSend = 'compose_send';

  /// An AI-row run (polish/organize/translate) that did not produce a result (R6 T-3b ④).
  static const String aiCompose = 'ai_compose';

  /// An image send that did not reach the PC (R6 T-4). Its OWN id, not
  /// [composeSend]: the two carry different fixes (grant photo access / pick a
  /// smaller picture vs. reconnect), so collapsing them onto one key would let
  /// a text failure overwrite an image failure the user still has to act on.
  static const String imageSend = 'image_send';

  /// Window B3-2b — 「还有 N 条未投递」("N still not delivered"). owner's NON-BLOCKING observability: it adds
  /// no interception step (「不管时间多久全部都要投递」"however long it takes,
  /// everything must still be delivered"), it only lets the user SEE
  /// how much is still owed. Its own id because it describes a STANDING fact
  /// about the queue, not an event — pushing it onto any failure key would let
  /// one clear the other.
  static const String outboxPending = 'outbox_pending';

  // 🔴 `pcBusy = 'pc_busy'` was DELETED 2026-08-11 (fix-001). It identified the
  // 「另一台手机正连着这台电脑」("another phone is currently connected to this
  // PC") STATE banner (card L7 / owner 2026-08-02, Book 15 §2.5d),
  // whose whole premise — the second phone stays here and waits — owner overruled
  // (「有且只能有一个手机连上来……铁律生死线」"there must be one, and only
  // one, phone connected … an iron rule, a red line"). The phone now leaves the screen
  // instead; see `chat_flow_page._maybeLeaveOnCapsuleTaken`. Recorded here rather
  // than silently vanishing, because a reader who greps `pc_busy` and finds
  // nothing deserves to know it was retired rather than lost.

  /// Window B3-2b — a terminal the QUEUE ITSELF decided (bytes gone / overflow).
  /// Its own id, not [outboxPending]: 「还有 N 条在排队」("N still queued") and
  /// 「有一条永远不会投出去了」("one will never be delivered")
  /// are opposite news, and collapsing them would let a routine count
  /// overwrite a permanent loss.
  static const String outboxTerminal = 'outbox_terminal';

  /// card U2 — the mic-permission flow (rationale / denied / permanently-denied /
  /// capture-start-failed share ONE id: they are four faces of the same fact,
  /// so a transition REPLACES rather than stacks). Pushed by
  /// mic_permission_banner.dart, which owns the face→severity/action mapping.
  static const String micPermission = 'mic_permission';

  // `timelineConflict` was removed in 0.2.27 with the banner it keyed (see
  // buildChatBanners). A banner id nothing can push is dead weight that reads
  // like a live surface.
}

/// The single-slot banner queue: insertion-ordered storage, priority-ordered
/// reads. Plain state (not a ChangeNotifier) — the owner decides when to notify.
class BannerQueue {
  final List<BannerItem> _items = <BannerItem>[];

  int get length => _items.length;
  bool get isEmpty => _items.isEmpty;
  bool get isNotEmpty => _items.isNotEmpty;
  bool contains(String id) => _items.any((BannerItem i) => i.id == id);

  /// Enqueue [item], or refresh the existing entry with the same id IN PLACE
  /// (keeping its insertion rank, so a re-pushed banner does not jump the FIFO
  /// tie-break). Returns whether the queue content actually changed.
  bool push(BannerItem item) {
    final int at = _items.indexWhere((BannerItem i) => i.id == item.id);
    if (at < 0) {
      _items.add(item);
      return true;
    }
    if (_items[at] == item) return false; // identical face → no churn
    _items[at] = item;
    return true;
  }

  /// Drop the entry with [id] (dismiss, or the condition cleared). Returns
  /// whether anything was removed.
  bool remove(String id) {
    final int at = _items.indexWhere((BannerItem i) => i.id == id);
    if (at < 0) return false;
    _items.removeAt(at);
    return true;
  }

  /// Empty the queue (mode reset / session teardown). Returns whether anything
  /// was there.
  bool clear() {
    if (_items.isEmpty) return false;
    _items.clear();
    return true;
  }

  /// The one entry the slot renders: highest severity, ties broken by insertion
  /// order (first pushed wins). Null when the queue is empty.
  BannerItem? get top {
    BannerItem? best;
    for (final BannerItem item in _items) {
      // Strict `<` keeps the FIFO tie-break: a later equal-severity entry never
      // displaces an earlier one.
      if (best == null || item.severity.index < best.severity.index) {
        best = item;
      }
    }
    return best;
  }

  /// How many entries are queued BEHIND [top] — the 「还有 N 条」("N more") count.
  int get overflowCount => _items.isEmpty ? 0 : _items.length - 1;

  /// Every entry in display (priority) order — the expanded list. Sorted by
  /// (severity, insertion index) with an explicit index decoration because
  /// `List.sort` is not guaranteed stable.
  List<BannerItem> get all {
    final List<MapEntry<int, BannerItem>> decorated =
        <MapEntry<int, BannerItem>>[
          for (int i = 0; i < _items.length; i++) MapEntry<int, BannerItem>(i, _items[i]),
        ];
    decorated.sort((MapEntry<int, BannerItem> a, MapEntry<int, BannerItem> b) {
      final int bySeverity =
          a.value.severity.index.compareTo(b.value.severity.index);
      return bySeverity != 0 ? bySeverity : a.key.compareTo(b.key);
    });
    return <BannerItem>[for (final MapEntry<int, BannerItem> e in decorated) e.value];
  }
}

/// Map the chat flow's LIVE banner sources onto one queue. Pure function over
/// primitives (no widget, no controller) so the source→severity contract is
/// unit-testable on its own.
///
/// Severity ruling (REDESIGN P-2 colour semantics: red = a fault needing
/// intervention / yellow = degraded):
///   - `disconnected` / `error` → **blocking**: the PTT gate is closed, nothing
///     can be recorded — that is an outright block, not a degrade.
///   - `connecting` / `reconnecting` → **degraded**: capture continues and the
///     ring buffer replays on the reconnect edge (08 §4), so it is a warning.
///   - auto-stopped → **degraded** + dismissible: the recording really ended,
///     but nothing failed to deliver; it describes a PAST event, so the user is
///     allowed to clear it (R6 P0-R3).
///
/// The link entry is pushed FIRST so it wins the FIFO tie-break against an
/// equally-degraded auto-stop notice (the transport is the more urgent truth).
///   - a failed ComposeBand send → **blocking**: a delivery the user explicitly
///     asked for did not happen, which is a fault needing intervention (P-2 red).
///     It IS dismissible, because unlike a link drop it describes a PAST attempt
///     rather than a live condition the user is still trapped in. M2: when the
///     caller passes [onRetrySendFailure] it also carries a resend action.
///   - a failed AI run → **blocking**, EXCEPT [AiComposeFailure.aborted] which
///     is **degraded**: the user themselves discarded the buffer, so it is a
///     notice that the run is void, not a fault they must act on. Either way it
///     is said out loud — a run that quietly evaporates is a silent failure,
///     and an LLM failure must never look like nothing happened.
///   - a stalled PROCESSING (GA-03) → **blocking**: the user held PTT, spoke,
///     and got NOTHING back — that is a fault needing intervention (P-2 red), not
///     a degrade. Dismissible for the same reason a failed send is: it describes
///     a past utterance, and the FSM has already returned to IDLE so the user is
///     not trapped. It is pushed AFTER the link entry so an equally-blocking link
///     drop keeps the slot (the transport is the more actionable truth, and it
///     is usually the CAUSE of the stall).
BannerQueue buildChatBanners({
  required ConnectionState connection,
  required bool autoStopped,
  required AppStrings strings,
  /// 🔴 fix-026 — the WIRE `reason` of that auto-stop
  /// (`AudioAutoStoppedSchema.reason`), or null/'' when the caller does not
  /// know. A SECOND parameter beside [autoStopped] because it answers a second
  /// question; the flag still decides whether there is a banner at all.
  ///
  /// Both 「不知道」("unknown") spellings land in
  /// [AppStrings.recordingAutoStoppedMessage]'s unknown branch, which states
  /// only what the event itself proves. 🔴 Neither may fall back to the
  /// five-minute sentence: that sentence is a specific claim about a specific
  /// ceiling, and it was shown for every cause there is until this card.
  String? autoStopReason,
  /// RV-60: system photo picker is open on this phone — a drop inside this
  /// window is expected. Soft copy, never a failure banner; still says the
  /// link will recover (does NOT claim it stayed up).
  bool albumAway = false,
  /// RV-60: the reconnect ladder is actively climbing. A bare `disconnected`
  /// while the ladder is running is 「正在重连」("reconnecting"), not 「网络已
  /// 断开」("network disconnected") — the latter
  /// is reserved for a link that nobody is trying to bring back.
  bool ladderReconnecting = false,
  SttStall? sttStalled,
  AiComposeOutcome? utteranceFailure,
  ComposeSendFailure? sendFailure,
  AiComposeOutcome? aiFailure,
  ImageSendOutcome? imageFailure,
  /// Window B3-2b — how many deliveries the queue still owes **on the instance this
  /// screen is showing** (RV-91: `DeliveryOutbox.pendingCountFor`, never the
  /// screen-wide total). 0 ⇒ no banner at all; there is nothing to say and a
  /// 「0 条未投递」("0 undelivered") chip would be a permanent fixture that tells the user nothing.
  int outboxPending = 0,
  // 🔴 `bool pcBusy` was DELETED 2026-08-11 (fix-001) together with the banner it
  // fed — see [BannerIds] and the push site below. The FACT it carried still
  // exists and is still bucketed the same way (`PttSession.pcBusyOnScreen`); what
  // changed is its consumer: the page now LEAVES on it instead of drawing on it.
  /// Window B3-2b — the queue's own most recent terminal, or null.
  OutboxTerminal? outboxTerminal,
  void Function()? onDismissOutboxTerminal,
  void Function()? onDismissAutoStop,
  void Function()? onDismissSttStalled,
  void Function()? onDismissUtteranceFailure,
  void Function()? onDismissSendFailure,
  void Function()? onDismissAiFailure,
  void Function()? onDismissImageFailure,
  void Function()? onRetrySendFailure,
}) {
  final BannerQueue queue = BannerQueue();
  final BannerItem? link = _linkBanner(
    connection: connection,
    albumAway: albumAway,
    ladderReconnecting: ladderReconnecting,
    strings: strings,
  );
  if (link != null) queue.push(link);
  if (autoStopped) {
    queue.push(
      BannerItem(
        id: BannerIds.autoStop,
        severity: BannerSeverity.degraded,
        // 🔴 fix-026 — was `strings.recordingAutoStopped` unconditionally, i.e.
        // 「录音已达 5 分钟上限」("recording has reached the 5-minute cap") no matter what ended the recording. The selector
        // is keyed on the wire string, so a reason added to the protocol needs
        // no edit here; it needs a sentence over in recording_strings.dart, and
        // until it has one the user reads the raw identifier instead of a
        // confident sentence about something nobody verified.
        message: strings.recordingAutoStoppedMessage(autoStopReason ?? ''),
        dismissible: true,
        onAction: onDismissAutoStop,
      ),
    );
  }
  if (sttStalled != null) {
    queue.push(
      BannerItem(
        id: BannerIds.sttStall,
        severity: BannerSeverity.blocking,
        // ENG-3: the stall event carries the wire code, so a NAMED engine
        // refusal (STT_CONFIG_MISSING) renders its own sentence instead of the
        // generic 「转写引擎报错」("transcription engine error"). Selector: recording_strings.dart, keyed on the
        // wire string (same discipline as recordingAutoStoppedMessage).
        message: strings.sttStallBannerMessage(sttStalled),
        dismissible: true,
        onAction: onDismissSttStalled,
      ),
    );
  }
  // GA-01: a spoken utterance whose transform failed. Blocking for the same
  // reason a failed ➤ is — a delivery the user asked for did not happen — and
  // dismissible for the same reason too (it describes a past utterance). It
  // reuses [AppStrings.aiComposeError] so the user reads the SAME named wall
  // (quota / auth / model / timeout) whichever run hit it.
  if (utteranceFailure != null) {
    queue.push(
      BannerItem(
        id: BannerIds.utteranceCompose,
        severity: BannerSeverity.blocking,
        message: strings.utteranceComposeError(utteranceFailure),
        dismissible: true,
        onAction: onDismissUtteranceFailure,
      ),
    );
  }
  if (sendFailure != null) {
    // M2: when the caller can name the failed row, the banner offers a resend
    // action next
    // to the message — the action fires the retry, ✕ stays a pure dismiss
    // (firing the retry from ✕ would be a destructive surprise).
    final bool retryable = onRetrySendFailure != null;
    queue.push(
      BannerItem(
        id: BannerIds.composeSend,
        severity: BannerSeverity.blocking,
        message: strings.composeSendError(sendFailure),
        actionLabel: retryable ? strings.resendAction : null,
        onAction: retryable ? onRetrySendFailure : onDismissSendFailure,
        onDismiss: retryable ? onDismissSendFailure : null,
        dismissible: true,
      ),
    );
  }
  // R6 T-4: an image the user explicitly sent that did not arrive — blocking,
  // for the SAME reason a failed ➤ is: a delivery they asked for did not happen.
  // Dismissible because it describes a past attempt, not a live trap.
  if (imageFailure != null) {
    queue.push(
      BannerItem(
        id: BannerIds.imageSend,
        severity: BannerSeverity.blocking,
        message: strings.imageSendError(imageFailure),
        dismissible: true,
        onAction: onDismissImageFailure,
      ),
    );
  }
  if (aiFailure != null) {
    queue.push(
      BannerItem(
        id: BannerIds.aiCompose,
        severity: aiFailure.reason == AiComposeFailure.aborted
            ? BannerSeverity.degraded
            : BannerSeverity.blocking,
        message: strings.aiComposeError(aiFailure),
        dismissible: true,
        onAction: onDismissAiFailure,
      ),
    );
  }
  // ── Window B3-2b: THE QUEUE'S TWO SURFACES ─────────────────────────────
  //
  // 🔴 `outboxTerminal` is BLOCKING, for the same reason a failed ➤ is: a
  // delivery the user asked for did not happen and never will. Dismissible
  // because it describes a past event, not a live trap. Until this line existed
  // the sentence was produced and shown to nobody — `delivery_outbox.dart` said
  // so at its own definition, in as many words.
  if (outboxTerminal != null) {
    queue.push(
      BannerItem(
        id: BannerIds.outboxTerminal,
        severity: BannerSeverity.blocking,
        message: strings.outboxTerminalMessage(outboxTerminal),
        dismissible: true,
        onAction: onDismissOutboxTerminal,
      ),
    );
  }
  // 🔴 DELETED 2026-08-11 (fix-001) — 「另一台手机正连着这台电脑」("another
  // phone is currently connected to this PC") used to push a
  // `degraded` STATE banner here (card L7 / owner 2026-08-02, Book 15 §2.5d).
  //
  // owner overruled the behaviour it explained: 「出现胶囊窗口的时候，有且只能有一个
  // 手机连上来……一定要作为一个铁律生死线」("when the capsule window appears,
  // there must be one, and only one, phone connected … this has to be an
  // iron rule, a red line"). The second phone no longer STAYS on the
  // transcription screen being told to wait — it is returned to the connections
  // list (`chat_flow_page.dart` `_maybeLeaveOnCapsuleTaken`, the sentence lives
  // in `chat_strings.capsuleTakenNotice`).
  //
  // ⇒ The banner is DELETED rather than left unpushed. It had exactly one screen
  //   to live on and that screen is now being exited; a banner that can never be
  //   drawn is a façade, and 「能力定义了没人调用」("a capability got defined
  //   and nothing calls it") is this repo's #1 historical bug
  //   class. `BannerIds.pcBusy` and `strings.pcBusyNotice` went with it — a banner
  //   id with no push and a sentence with no reader are the same thing wearing
  //   different hats.
  //
  // 🔴 `outboxPending` is INFO AND NOT DISMISSIBLE, and both halves are the
  // ruling rather than taste.
  //
  //   · INFO because owner ruled the queue must add NO interception step
  //     (「不管时间多久全部都要投递」"however long it takes, everything must
  //     still be delivered"): it loses every priority contest, so it can
  //     never sit in front of something the user has to act on — it waits behind
  //     「还有 N 条」("N still remaining") until nothing is wrong, which is when a count is worth
  //     reading anyway. Pushed LAST for the same reason (FIFO tie-break).
  //   · NOT DISMISSIBLE because it is a LIVE condition, like the link row, not a
  //     past event: it clears itself the moment the count reaches zero. A ✕ here
  //     would let the user silence a truth that is still true — and then the
  //     next queued item would raise it again anyway, which is a worse control
  //     than none.
  //
  // ⚠️ The copy must never say 「已发送」("sent") (outbox_item.dart:17-20); owner has paid
  // once for a promise that had not been kept.
  if (outboxPending > 0) {
    queue.push(
      BannerItem(
        id: BannerIds.outboxPending,
        severity: BannerSeverity.info,
        message: strings.outboxPendingNotice(outboxPending),
      ),
    );
  }
  // 0.2.27: the C5 cross-device conflict banner was HERE. Both of its messages
  // described the server overruling this device — a peer edit that won, or a peer
  // delete that removed the row — and both were produced by exactly one thing,
  // the `history:update` ack. With the uplink retired (owner's architecture
  // ruling: the cloud does not store transcripts) there is no peer writing
  // this phone's rows, so neither notice can ever
  // be true again. Deleted rather than kept: a message that can never render is a
  // façade on the copy face, and the store method that raised it
  // (`removeDeletedByPeer`) would have DELETED a real local row on the strength
  // of an error code that only ever meant 「id 不在表里」("the id isn't in the table").
  return queue;
}

/// Link-row face for [buildChatBanners]. Kept as its own pure function so the
/// three postures (album-away / ladder climbing / truly down) stay one place
/// and unit-testable without rebuilding the whole queue.
BannerItem? _linkBanner({
  required ConnectionState connection,
  required bool albumAway,
  required bool ladderReconnecting,
  required AppStrings strings,
}) {
  if (connection == ConnectionState.connected) return null;
  // Album window wins: the phone itself opened the picker — that is a
  // different fact from a random drop the ladder is healing.
  if (albumAway) {
    return BannerItem(
      id: BannerIds.link,
      severity: BannerSeverity.degraded,
      message: strings.bannerAlbumAway,
    );
  }
  final bool soft = connection == ConnectionState.connecting ||
      connection == ConnectionState.reconnecting ||
      ladderReconnecting;
  if (soft) {
    return BannerItem(
      id: BannerIds.link,
      severity: BannerSeverity.degraded,
      message: strings.bannerReconnecting,
    );
  }
  return BannerItem(
    id: BannerIds.link,
    severity: BannerSeverity.blocking,
    message: strings.bannerLinkDown,
  );
}
