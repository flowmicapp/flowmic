// Part of chat_controller.dart — THE FIVE INBOUND ROUTERS.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────────
// chat_controller.dart sits at the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX = 800) and card CR-5 needs one more field on it. Same practice as
// every split before it: take a coherent family out WHOLE rather than trim the
// evidence a comment carries.
//
// The family is coherent because it answers one question end to end: 「when a
// frame arrives on one of this controller's five subscriptions, where does it
// land?」 Each member is a router and nothing else — four are one-liners
// delegating to a part that already exists, and the fifth fans one event out to
// two compose controllers. None of them decides anything, which is exactly why
// they read as noise in the middle of a class that does.
//
// 🔴 DIFF DISCIPLINE: every line below is moved **character-for-character**,
// with the one mechanical edit this family always makes — they become extension
// members, so `_onFsmChange` and its four siblings keep their names and their
// call sites (the `listen(...)` arguments in the constructor). **Any other
// difference in the diff is a bug.**
//
// ⚠️ These are LIBRARY-PRIVATE and stay so. An extension member with a leading
// underscore is visible to the whole library and to nothing else, which is the
// same reach they had as private class members — a split must not widen a
// surface as a side effect of moving it.

part of 'chat_controller.dart';

extension ChatControllerInboundRoutes on ChatController {
  /// CR-5 — the language recovery announces on its `audio:start`.
  ///
  /// Filed with the routers because the two edges that sweep are here, and
  /// it is read by nothing else.
  ///
  /// ⚠️ The user's CURRENT setting, which is a deliberate approximation with
  /// a stated cost: the honest value would be the setting in force when
  /// those bytes were spoken, and nothing on disk records it (the retained
  /// layer stores audio, not metadata — it is forbidden to become an
  /// archive). Someone who changes their spoken language between an outage
  /// and its recovery gets the new one. Registered rather than hidden; the
  /// fix, if it is ever wanted, is a field on the article head, not a second
  /// guess here.
  String get _recoverySourceLang =>
      appSettings?.spokenLang ?? kSpokenLangDefault;

  void _onAiCompose(AiComposeEvent e) {
    aiCompose.onEvent(e);
    utteranceCompose.onEvent(e);
  }

  // inject:result → ManualDelivery claim + F3 ack→visible + bar retreat.
  void _onInjectResult(InjectResult r) => onInjectResultRouted(this, r);

  // ── focus:state → transient header label ─────────────────────────────
  void _onFocusState(FocusState f) => destination.onFocusApp(f.appLabel);

  // Body: chat_notices.dart (RV-92). Same family as the buffer/notice routes.
  void _onPcPresenceChanged() => onPcPresenceChangedRouted(this);

  // ── connection edges: destination stickiness reset (§4.0 B) ──────────
  void _onFsmChange(FlowmicStateSnapshot s) => onFsmChangeRouted(this, s);
}
