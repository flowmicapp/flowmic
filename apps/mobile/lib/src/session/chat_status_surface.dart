// Part of chat_controller.dart — the truths this controller is REQUIRED to put
// in front of the user, and the ✕ that closes each one (lane K, 2026-08-05).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart sat at 799 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800; see chat_ptt_lifecycle.dart's header for the full reason and
// for why the mechanism here is an `extension` rather than an eighth
// `xxxRouted` top-level function, plus the price that choice carries.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every member below — declaration, doc
// comment and body — is byte-for-byte what it was in chat_controller.dart.
// Unlike chat_ptt_lifecycle.dart this file needed NOT EVEN the `notifyUi`
// edit: every body here delegates, so none of them touches `notifyListeners`.
// **Any diff at all is a bug.**
//
// WHY THIS SET AND NOT SOME OTHER SET: this is the complete set of exits
// through which 「没有静默失败」 ("no silent failure", 13 册 §7 F2) and R11
// 「转录消息的状态一定要对」 ("the transcript message's status must be correct")
// reach the screen from this controller. They come in pairs — a value and a ✕ —
// and that shape is not a coincidence: a red line says a thing that did not
// happen must stay visible AND must be dismissed by the user, never by a timer
// deciding on its own. The set moves as one because it is already listed as one
// TWICE elsewhere: chat_banner_sources.dart (lines 55/61/64/66/68/71/80/89 and
// the onDismiss* block at 93-99) and chat_transient_banner_timers.dart
// (95/97/100/103/107/110). Adding one banner means editing those two tables and
// this file together.
//
// ⚠️ THE THREE FIELDS BEHIND THESE GETTERS STAYED IN THE CLASS
// (`_autoStopped` / `_sttStalled` / `_utteranceFailure`), together with the long
// comments above them. A `part of` file cannot reopen a class, and those
// comments belong to the fields — moving a comment away from what it documents
// is a rewrite, not a move.
//
// ⚠️ TWO MOVED COMMENTS CARRY POSITIONAL WORDS FROM THEIR OLD HOME: the queue
// section says 「repaint through `onOutboxChanged` above」 and one line says
// 「Before this card」. They are moved VERBATIM (this card does not rewrite
// existing prose), so read those two words against chat_controller.dart, where
// `onOutboxChanged` still is.

part of 'chat_controller.dart';

extension ChatStatusSurface on ChatController {
  /// The last ComposeBand failure, held until the user dismisses it. A delivery
  /// that did not happen must stay visible (没有静默失败 — "no silent failure"). Owned by
  /// [ManualDelivery]; re-exposed here so the page keeps reading one object.
  ComposeSendFailure? get sendFailure => delivery.failure;

  void dismissSendFailure() => delivery.dismissFailure();

  /// The last image-send failure (R6 T-4). A SEPARATE banner from
  /// [sendFailure] because the fixes differ: a denied photo permission is
  /// resolved in the OS settings, an over-budget picture by picking another.
  ImageSendOutcome? get imageFailure => imageSend.failure;

  void dismissImageFailure() => imageSend.dismissFailure();

  /// Entry ids whose bubbles show the polish-skipped corner mark. In-memory for
  /// the session; cleared only on dispose (app restart drops it naturally).
  Set<String> get polishSkippedEntryIds => _polishSkippedEntryIds;

  /// True while the fail-loud "recording auto-stopped at the 5-min cap" banner
  /// should show. Transient UI signal only — never touches the timeline schema.
  ///
  /// 🔴 G-20 ① — **for the instance whose screen is asking**. A notice parked
  /// on another instance is hidden here, not dropped: switching back shows it
  /// again (§2.5.1 是「藏」不是「丢」 — "it is HIDDEN, not DROPPED"). Gate shared with `autoStopReason`.
  bool get autoStopped => _autoStoppedOnScreen;

  /// Dismiss the auto-stop banner (user tapped ✕). Body: chat_notices.dart.
  void dismissAutoStopped() => dismissAutoStoppedRouted(this);

  /// Non-null while the fail-loud "no transcript came back" banner should show,
  /// carrying WHY (timeout vs engine error — and, for a terminal `stt:error`,
  /// the wire code, ENG-3). Cleared by a fresh PTT-down or ✕.
  ///
  /// 🔴 G-20 ② — scoped like [autoStopped]; hidden while parked elsewhere.
  SttStall? get sttStalled =>
      _noticeOnScreen(_sttStalledInstanceId) ? _sttStalled : null;

  /// Dismiss the stall banner (user tapped ✕). Body: chat_notices.dart.
  void dismissSttStalled() => dismissSttStalledRouted(this);

  /// 🔴 G-20 ③ — scoped like [autoStopped]; hidden while parked elsewhere.
  AiComposeOutcome? get utteranceFailure =>
      _noticeOnScreen(_utteranceFailureInstanceId) ? _utteranceFailure : null;

  void dismissUtteranceFailure() => dismissUtteranceFailureRouted(this);

  // ── window B3-2b: the queue's USER-VISIBLE surface ───────────────────────────
  // Re-exposed here (not reached into from the page) for the same reason
  // `sendFailure` / `imageFailure` are: the page reads ONE object, and all of
  // these repaint through `onOutboxChanged` above.
  //
  // 🔴 EVERY MEMBER BELOW NAMES ITS PRODUCTION CONSUMER. Before this card,
  // `pendingCountFor` / `terminalNotice` / `dismissTerminalNotice` /
  // `canResendImage` had ZERO readers between them. If a named consumer greps
  // empty, that member is a façade again and must go, not wait 「for later」.

  /// 「还有 N 条待投递」 ("N still pending delivery") on THIS instance (RV-91;
  /// card L7 only changed the wording, not the counting, 15 册 §2.0.1).
  int get outboxPending => outbox.pendingCountFor(session.connectedInstanceId);

  /// The queue's own most recent terminal — **for the instance whose screen is
  /// asking** (G-20 ⑤; same scope as [outboxPending], same hide-not-drop rule
  /// as [autoStopped]). Consumer: `BannerIds.outboxTerminal`.
  OutboxTerminal? get outboxTerminal =>
      outbox.terminalNoticeFor(session.connectedInstanceId);

  /// The ✕ on that banner. Consumer: `chatBannerSources.onDismissOutboxTerminal`.
  void dismissOutboxTerminal() => outbox.dismissTerminalNotice();

  /// Rows whose delivery is still ON DISK and has never been on the wire.
  /// Consumer: `chat_flow_page._scroll` → `ChatMessageTile.queued` → 「排队中」 ("queued").
  Set<String> get queuedEntryIds => outbox.queuedEntryIds;

  /// Image rows whose compressed copy is still on disk. Consumer:
  /// `ChatMessageTile.canResendImage` — whether the resend affordance exists at
  /// all (owner's two-stage model / R8).
  Set<String> get resendableImageEntryIds => outbox.resendableImageEntryIds;

  /// The last AI failure, held until dismissed (fail-loud, carries the raw
  /// server code).
  AiComposeOutcome? get aiFailure => aiCompose.failure;

  void dismissAiFailure() => aiCompose.dismissFailure();
}
