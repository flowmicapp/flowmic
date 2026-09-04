// Part of chat_controller.dart — 「WHICH SCREEN IS THIS NOTICE NEWS FOR」 (G-20).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart reached 801 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800 after two workstreams merged. This repo's established practice
// is **structural splitting, not deleting evidence** — what gets cut is
// 「内容不该在这里」("content that does not belong here"), never
// 「内容太长」("content that is too long"). See chat_ptt_lifecycle.dart's header
// for why the shape here is an `extension` rather than an eighth `xxxRouted`
// top-level function, and for the price that choice carries.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR (2026-09-04). All four members below —
// declaration, doc comment and body — are byte-for-byte what they were in
// chat_controller.dart. This file needed NOT EVEN the one mechanical edit the
// Lane K files declare (`notifyListeners()` → `notifyUi()`): none of these four
// repaints. **Any diff at all is a bug.**
//
// WHY THIS SET AND NOT SOME OTHER SET: the code named this family before I did.
// [_noticeOnScreen]'s own doc reads 「THE one equality judgement for the six
// per-instance transient notices this controller family holds … one scope for
// the whole family, not six near-misses (ruling G-20, 2026-08-05)」. The other
// three are that judgement's only two derivations ([_autoStoppedOnScreen] and
// the [autoStopReason] gate built on it) and the ONE writer that stamps the
// value the judgement compares against ([_raiseUtteranceFailure], G-20 ③).
// One question — 「is this notice about the instance currently on screen?」 —
// one file.
//
// ⚠️ THE FIELDS DID NOT MOVE AND CANNOT: `_autoStoppedInstanceId`,
// `_sttStalledInstanceId`, `_utteranceFailureInstanceId`, `_autoStopReason`,
// `_autoStopped` and `_utteranceFailure` all stay in the class body, because an
// extension cannot declare a field — the same constraint chat_ptt_lifecycle.dart
// wrote down. Each of them kept its doc comment where it stands; only the
// members above travelled, and chat_controller.dart carries a pointer at each of
// the three places they left.
//
// ⚠️ NOTHING REQUIRED BY AN INTERFACE IS IN HERE. Extension members are resolved
// STATICALLY and do NOT implement interfaces, so no `@override` of
// AiComposeHost / ManualDeliveryHost / UtteranceComposeHost / OutboxDrainHost
// could ever live here. [autoStopReason] is a plain public getter (its consumer
// is `chat_banner_sources.dart` → `buildChatBanners(autoStopReason:)`), and the
// other three are private to this library.
//
// Callers, unchanged: chat_notices.dart, chat_ptt_lifecycle.dart,
// chat_status_surface.dart and chat_utterance.dart reach these through a
// `ChatController` receiver, which is exactly how they already reached them.
// Pinned by `test/g20_instance_bucket_test.dart` and
// `test/autostop_reason_wire_test.dart`.

part of 'chat_controller.dart';

extension ChatNoticeScope on ChatController {
  /// G-20 — 「does this transient notice belong to this screen」. THE one equality judgement for the
  /// six per-instance transient notices this controller family holds; the
  /// stamped value and `session.connectedInstanceId` are the same vocabulary
  /// RV-91/RV-97/B4-18 already compare. ⚠️ `null == null` is a REAL match, not
  /// a wildcard: two cloud instances cannot be told apart, and the honest
  /// disposition is to keep showing the notice rather than swallow it.
  bool _noticeOnScreen(String? stampedInstanceId) =>
      stampedInstanceId == session.connectedInstanceId;

  /// G-20 ① — the gate [ChatStatusSurface.autoStopped] and [autoStopReason]
  /// share, so 「whether the banner is drawn」 and 「whether the reason is
  /// handed out」 can never answer differently.
  bool get _autoStoppedOnScreen =>
      _autoStopped && _noticeOnScreen(_autoStoppedInstanceId);

  /// The wire `reason` behind the auto-stop notice **currently on screen**, or
  /// null when there is no such notice.
  ///
  /// 🔴 Gated on [_autoStopped] rather than exposing the raw field: a reason
  /// that outlives the banner it explains is a value describing a fact that is
  /// no longer true, and the three writers that clear the flag would each have
  /// to remember to clear this one too. Gating makes that impossible by
  /// construction instead of by discipline.
  ///
  /// Consumer: `chat_banner_sources.dart` → `buildChatBanners(autoStopReason:)`
  /// → `AppStrings.recordingAutoStoppedMessage`. Declared in the class body
  /// rather than beside `autoStopped` in chat_status_surface.dart only because
  /// that file is outside this card's ownership.
  ///
  /// G-20 ①: gated on [_autoStoppedOnScreen] (not the raw flag) so a reason can
  /// never be handed out for a banner parked on another instance's screen.
  String? get autoStopReason => _autoStoppedOnScreen ? _autoStopReason : null;

  /// G-20 ③ — the ONE writer of [_utteranceFailure], so the value and its
  /// screen stamp are decided in the same statement and can never drift apart
  /// (the `ManualDelivery._raise` precedent). The four raise sites live in
  /// chat_utterance.dart; grep them if this claim ever needs re-checking.
  void _raiseUtteranceFailure(AiComposeOutcome outcome) {
    _utteranceFailure = outcome;
    _utteranceFailureInstanceId = session.connectedInstanceId;
  }
}
