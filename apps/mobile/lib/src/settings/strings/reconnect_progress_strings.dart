// AppStrings copy catalogue shard: card NR-96 — what the phone says while
// something is being reconnected automatically, and when it gives up.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-reconnect-visibility-design.md §3.1 (the five
//     rules), §3.2 (「attempt n」 / 「attempt n of N」, never a countdown),
//     §5.1 (who reads each key, on which screen, and what it means)
//
// 🔴 THE VALUES ARE `DEV:` PLACEHOLDERS. D-47: the sentences are written by the
// copy lane, not by the card that wires them. Tests assert against these
// getters, never against the placeholder wording.
//
// 🔴 ONE OBJECT PER FAMILY, and they must not share words (§3.1 rule 1). The
// `rec*` / `articleLive*` keys are about the link from the SERVER to the speech
// engine; the `banner*` keys are about the link from this PHONE to the server.
// The first asks nothing of the user, the second may be their network — the
// same 「reconnecting」 on both would send them to fix the wrong thing.
part of '../app_strings.dart';

mixin ReconnectProgressStrings on AppStringsLeaves {
  /// NR-96-B — the push-to-talk strip's engine chip, when the relay did not
  /// say how many attempts the ladder has (an old relay, or an unbounded
  /// ladder). [n] is the relay's `retry_count`.
  String recEngineReconnecting(int n) => _lfRecEngineReconnecting(n);

  /// NR-96-B — the same chip when the relay named the budget (`retry_max`).
  String recEngineReconnectingOf(int n, int max) =>
      _lfRecEngineReconnectingOf(n, max);

  /// NR-96-B — the long recording's status line (the in-progress article
  /// page) and the chip on its `ContinuousLiveBar`. Only the 「attempt n」 form
  /// exists here, by design §3.3: the long-recording ladder is meant to be
  /// unbounded (card F), and a total the user cannot rely on is not shown.
  String articleLiveEngineReconnecting(int n) =>
      _lfArticleLiveEngineReconnecting(n);

  /// Card RC-3 — the same line when the audio IS being kept on this phone
  /// (`ContinuousOffline.engineKept`, the journal storage face). The plain form
  /// above stays for the face that keeps nothing: SEG-2's kept/plain pair, the
  /// retention clause only where the retention is real.
  String articleLiveEngineReconnectingKept(int n) =>
      _lfArticleLiveEngineReconnectingKept(n);

  /// Card RC-3 — the chat page's banner while a long recording runs and the
  /// relay has lost its speech-engine leg, audio kept on this phone. Not
  /// [bannerContinuousOffline]: that one says the PHONE'S link is down.
  String get bannerContinuousEngineDownKept => _lfBannerContinuousEngineDownKept;

  /// Card RC-3 — the same banner when nothing on this phone keeps the audio
  /// (`ContinuousOffline.engine`): no retention claim.
  String get bannerContinuousEngineDown => _lfBannerContinuousEngineDown;

  /// NR-96-E1 — `mobile:reconnect` went unanswered four times in a row and
  /// the phone has stopped asking on its own. Event-type, dismissible, carries
  /// [reconnectNowAction]. Not [sessionLostToast]: that one is the socket
  /// ladder giving up, this one is a server that does not answer.
  String get reconnectAckLostNotice => _lfReconnectAckLostNotice;

  /// NR-96-E2 — the link banner while the phone's own reconnect ladder is
  /// climbing, with the rung number. Unbounded ladder ⇒ this form.
  String bannerReconnectingN(int n) => _lfBannerReconnectingN(n);

  /// NR-96-E2 — the same banner when the ladder has a budget (`maxAttempts`).
  String bannerReconnectingNOf(int n, int max) =>
      _lfBannerReconnectingNOf(n, max);
}
