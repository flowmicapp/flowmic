// Part of chat_controller.dart — the TRANSIENT PAGE NOTICES and the buffer
// discard they share (window B3-2b).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart sat EXACTLY on the 800-line cap, so the queue's
// user-visible surface (「还有 N 条未投递」 ("N still undelivered") + the queue's
// own terminal sentence) could not be added without deleting something. The
// coordinator's card named the only wrong way to do that: 「别等 lint 报了再临时
// 压注释——压掉的都是说理文字，那是本仓最贵的东西」 ("don't wait for lint to
// complain and then squeeze the comments as a stopgap — what gets squeezed out
// is always the reasoning prose, and that is the most valuable thing in this
// repo"). So the bodies moved out whole, comments and all.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every body below is what it was in
// chat_controller.dart, with exactly TWO mechanical edits, both listed so the
// claim stays checkable: (1) the receiver is explicit ([c]) — the convention
// chat_utterance.dart / chat_outbox_host.dart already set; (2) `notifyListeners`
// became `c.notifyUi()`, because `notifyListeners` is `@protected` and a
// top-level function is not an instance member (it analyzes clean; the raw call
// does not). The class keeps the same method names, so every call site —
// including `chat_control_keys.dart:40` and `chat_utterance.dart:56`, which
// reach in from the other part files — is untouched.
// **Any diff beyond those two is a bug.**
//
// WHY THIS SET AND NOT SOME OTHER SET: they are one family. Each is a TRANSIENT
// page-level truth that deliberately does NOT live on TimelineEntry (the
// five-state face stays delivery-truth only) — the three notices, the live
// amplitude feed the recording panel reads, and the buffer discard whose whole
// job is to settle the rows a notice leaves behind. Reading them together is how
// 「哪些真相不该进时间线」 ("which truths must not go into the timeline") stays
// one answer.

part of 'chat_controller.dart';

/// RV-60 — the system photo picker opened or closed on this phone. It changes
/// the link banner without an FSM edge, so the sustained-disconnect watch has to
/// be re-evaluated by hand.
void onAlbumAwayChangedRouted(ChatController c) {
  _watchSessionLoss(c, c._conn);
  c.notifyUi();
}

/// R6 P0-R3 — the server hit the 5-min hard cap (`audio:auto-stopped`).
void onAutoStoppedRouted(ChatController c) {
  // The utterance was cut server-side; drop the live in-flight draft so the UI
  // does not leave a stranded "转录中" ("transcribing") row, and raise the
  // visible notice.
  c._liveText = '';
  c._autoStopped = true;
  // G-20 ①: the scope is read at the moment the fact is produced (§2.5.1
  // fourth rule), never at display time.
  c._autoStoppedInstanceId = c.session.connectedInstanceId;
  c.notifyUi();
}

/// Dismiss the auto-stop banner (user tapped ✕). No-op when already clear.
///
/// G-20 ①: gated on the SCOPED view, not the raw flag — a ✕ on this screen must
/// not sweep away a notice parked on another instance's screen (§2.5.1: an
/// action on this screen may only dismiss this screen's own conclusion —
/// 这块屏幕上的动作只许收走这块屏幕自己的结论). Unreachable in practice while parked
/// (the banner is not drawn here), but the gate makes it structural.
void dismissAutoStoppedRouted(ChatController c) {
  if (!c._autoStoppedOnScreen) return;
  c._autoStopped = false;
  c._autoStoppedInstanceId = null;
  c.notifyUi();
}

/// GA-03 — PROCESSING closed with no terminal `stt:final` (15 s safety net, or a
/// terminal `stt:error`).
void onSttStalledRouted(ChatController c, SttStall stall) {
  // No final is coming for this utterance: drop the in-flight draft so the UI
  // does not leave a stranded 「转录中」 ("transcribing") row (there will never be a committed
  // row to replace it), and raise the visible notice — a PTT press that
  // yielded nothing must be said out loud, never silently swallowed.
  c._liveText = '';
  // ── ENG-3 (fix-030) — THE EMPTY-FINAL RACE ─────────────────────────────────
  // On the measured P0 runs the server sends BOTH: a named terminal `stt:error`
  // (the engine could not open) and then an empty terminal `stt:final` (the
  // stop path flushing a run that heard nothing). The final arrives on
  // `stt.finals` — a stream the FSM does not gate — so `_handleTerminalFinal`'s
  // empty branch fires a SECOND stall (`emptyTranscript`) right after the
  // first, and an unconditional write here repainted 「转写引擎报错」 ("the
  // transcription engine errored") with 「没有听到语音，请靠近麦克风再说一次」
  // ("no speech was heard, please move closer to the microphone and try
  // again") — blaming the room for a module that
  // was never shipped. Within one utterance the NAMED refusal is strictly more
  // informative than 「the run it refused heard nothing」, so it holds the slot.
  // Scope guard, not a priority system: `pttDown` clears `_sttStalled`, so this
  // can never suppress a genuine empty transcript of a LATER utterance.
  final SttStall? held = c._sttStalled;
  // G-20 ②: the hold only applies WITHIN one utterance, and an utterance
  // happens on one instance — a named refusal parked on ANOTHER instance's
  // screen must not suppress this screen's stall. Without the scope term, the
  // scope guard this comment already relies on (「pttDown clears _sttStalled」)
  // would be broken by pttDown itself refusing to clear parked notices.
  final bool namedRefusalHolds = held != null &&
      c._noticeOnScreen(c._sttStalledInstanceId) &&
      held.reason == SttStallReason.engineError &&
      stall.reason == SttStallReason.emptyTranscript;
  if (!namedRefusalHolds) {
    c._sttStalled = stall;
    // G-20 ②: scope read at production time (§2.5.1 fourth rule).
    c._sttStalledInstanceId = c.session.connectedInstanceId;
  }
  c.notifyUi();
}

/// Dismiss the stall banner (user tapped ✕). No-op when already clear.
/// G-20 ②: refuses a notice parked on another instance — see
/// [dismissAutoStoppedRouted] for the rule.
void dismissSttStalledRouted(ChatController c) {
  if (c._sttStalled == null || !c._noticeOnScreen(c._sttStalledInstanceId)) {
    return;
  }
  c._sttStalled = null;
  c._sttStalledInstanceId = null;
  c.notifyUi();
}

/// Dismiss the utterance-transform banner (GA-01). No-op when already clear.
/// G-20 ③: refuses a notice parked on another instance — see
/// [dismissAutoStoppedRouted] for the rule.
void dismissUtteranceFailureRouted(ChatController c) {
  if (c._utteranceFailure == null ||
      !c._noticeOnScreen(c._utteranceFailureInstanceId)) {
    return;
  }
  c._utteranceFailure = null;
  c._utteranceFailureInstanceId = null;
  c.notifyUi();
}

/// 08 §2 清缓冲 ("clear buffer") red line — wipe the composer buffer and the STT segment cache.
void clearBufferRouted(ChatController c) {
  // A running AI operation's whole premise is the buffer it was handed. If
  // that buffer is being discarded (mode switch / ✕), the run is void — say
  // so instead of letting a later compose:done resurrect text the user just
  // cleared. restoreBuffer:false because the caller is about to blank it.
  c.aiCompose.abort(AiComposeFailure.aborted, restoreBuffer: false);
  // 🔴 T-6: the draft is being thrown away, so 「恢复原文」 ("restore original
  // text") has nothing left to be the original OF. `abort` above cannot carry
  // this — it returns at once
  // when no run is in flight, which is the ordinary case here (the transform
  // finished long ago and the user is discarding its product).
  c.aiCompose.forgetRestorable();
  c._discardBufferedRows();
  c._buffer = '';
  c._liveText = '';
  c.session.segments.clear();
}

/// master-plan §4.0 A: when the buffered text is DISCARDED (✕ / mode switch)
/// the utterances that fed it keep their rows — they really were said — but
/// their delivery truth settles at 📥 noted, because nothing was ever
/// delivered. Leaving them at ⏳ forever would be a lie the user never
/// resolves; deleting them would lose the record (记录是本体 — "the record IS
/// the substrate").
void discardBufferedRowsRouted(ChatController c) {
  for (final String id in c._bufferedEntryIds) {
    c.store.markNoted(id);
  }
  c._bufferedEntryIds.clear();
}

/// 🔴 RV-92 (owner 2026-08-01, real device) — PC absent (or presence unknown)
/// ⇒ **sweep away the 「target window name」**.
///
/// It belongs to the family this file declares: **a page-level transient truth
/// that deliberately does NOT go into TimelineEntry** (§4.1 「focus:state only
/// serves the header, never persisted」).
///
/// Before this, the only place that truth ever got swept was the 「socket
/// disconnected」 branch inside `onFsmChangeRouted` (chat_outbox_host.dart
/// :226). But in the scene the owner hit, **the socket was perfectly fine** —
/// it was connected to the cloud relay, the relay never exited, it was the PC
/// that exited ⇒ **nobody swept it**, and the screen kept showing a window
/// that no longer existed. §4.1's 「断连即清」 ("clear on disconnect") really
/// meant 「**它的来源不在了就清**」 ("clear once its source is gone"), not just
/// 「socket 断了才清」 ("clear only when the socket disconnects").
///
/// ⚠️ This only acts in ONE direction: **clearing**. It will never write a
/// window name — only the real `focus:state` may do that. This way the
/// listener can never become a second source of 「顶上写着什么」 ("what's shown
/// up top") (R4).
void onPcPresenceChangedRouted(ChatController c) {
  if (c.session.pcPresence.value == PcPresence.online) return;
  c.destination.clearFocus();
  c.notifyUi();
}

/// R6 T-5d — the DEVICE-side dBFS the recording panel's 📊 meter draws, measured
/// off the captured PCM (08 §3 RMS), never the server's `stt:level` echo: a wire
/// blip must not make the meter claim the mic went silent.
///
/// Gated on RECORDING so a late sample cannot animate a collapsed panel.
void onAmplitudeRouted(ChatController c, double db) {
  if (c._sess != SessionState.recording) return;
  c.recording.addAmplitude(db);
}
