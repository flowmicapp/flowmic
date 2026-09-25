// The banner ID registry, split VERBATIM out of banner_queue.dart.
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
// banner_queue.dart stood at 784 of the 800-line cap
// (`verify/lint/file-size.mjs` SRC_MAX) and card MP-14 adds one id plus one push
// site. Same practice as every split in this repo: take a coherent family out
// WHOLE rather than shave the reasoning prose to fit, and this class is the most
// self-contained family in that file — a registry of names, with the ruling
// behind each name, and not one line of behaviour.
//
// 🔴 EVERY LINE BELOW IS MOVED CHARACTER-FOR-CHARACTER. banner_queue.dart
// re-exports this file, so **no call site and no import changed** — `BannerIds`
// is still reached through `banner_queue.dart` everywhere it already was.
// **Any diff beyond this header is a bug.**

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

  /// Card CR-9 / owner §5-4 — a continuous recording is one minute from its
  /// per-sitting ceiling.
  ///
  /// 🔴 ITS OWN ID, NOT [autoStop]. That one reports a recording that has
  /// ALREADY ended; this one reports one that is still running and gives the
  /// user a minute to finish the sentence. Sharing an id would let either
  /// overwrite the other, and the two lead to opposite actions.
  static const String continuousCapWarning = 'continuous_cap_warning';

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

  /// Card PAIR-SUCCESS (owner 2026-08-25, 「这非常重要」): a DELIBERATE entry into
  /// the chat page just succeeded. EVENT-type — raised by the connections
  /// page's entry funnel only, never by a reconnect edge — and auto-hidden by
  /// the ChatController reconciler like every other past-event banner.
  static const String pairingSuccess = 'pairing_success';

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

  /// AUD-D F6 / P1-6 (2026-09-02) — `RetainedAudioStore` gave up or aged out
  /// unclaimed capture audio (`RetainedAudioNotice`, audio/retained_audio_store.dart).
  /// Before this id existed the diagnostics log was the ONLY surface for an
  /// event the store's own header requires callers to "hear" — the exact
  /// unbacked-promise shape volume 15 §2.0-b bans, one step later than the
  /// original defect those words were coined to fix. Its own id (not
  /// [sttStall] / [autoStop]): those describe what happened to the CURRENT
  /// utterance's transcript, this describes what happened to a RETAINED FILE
  /// that may belong to an utterance already off screen — collapsing them
  /// would let one overwrite the other while both are still news.
  static const String retainedAudioNotice = 'retained_audio_notice';

  /// Card MP-14 — the far end could not apply a control key this phone pressed
  /// (`control:key-result`, `ok:false`).
  ///
  /// 🔴 ITS OWN ID, NOT [composeSend]. That one says 「the frame never left this
  /// device」 and its fix is to reconnect; this one says 「it arrived and the
  /// computer would not run it」 and its fix is one of three other things
  /// (another destination / click into a box / press again). Sharing an id would
  /// let a transport failure erase a far-end refusal, and the two lead to
  /// different moves — the same argument [imageSend] makes against sharing with
  /// [composeSend].
  ///
  /// EVENT-type: it describes a press that is already over, so it is registered
  /// with the auto-hide reconciler like every other past-event banner.
  static const String controlKeyRefused = 'control_key_refused';

  /// Card NR-96-E1 — `mobile:reconnect` went unanswered past its bound and the
  /// phone has stopped asking on its own (`HoldOutRetry.noteLostAck`).
  ///
  /// 🔴 ITS OWN ID, NOT [link]. [link] is the socket, and in this state the
  /// socket is UP — the server simply never answered the ask to rejoin the
  /// room. Sharing the id would let a healthy link row erase the one sentence
  /// that says why nothing is being delivered. EVENT-type (design §4 E1).
  static const String reconnectAckLost = 'reconnect_ack_lost';

  /// Card RC-3 — a long recording is still capturing while the relay has lost
  /// its speech-engine leg. ITS OWN ID, NOT [link], for the reason
  /// [reconnectAckLost] gives: the socket is UP here, and the link row must not
  /// be the thing that speaks for (or erases) an engine outage. STATE-type:
  /// it goes when a leg is heard from again or the recording ends.
  static const String continuousEngineDown = 'continuous_engine_down';

  // `timelineConflict` was removed in 0.2.27 with the banner it keyed (see
  // buildChatBanners). A banner id nothing can push is dead weight that reads
  // like a live surface.
}
