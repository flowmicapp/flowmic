// Card LS-2 — the journal-facing half of AudioCapture, in a `part` of the same
// library so audio_capture.dart stays inside the 700-line limit the
// audio-durability plan sets (2026-08-27 status log §A9 stage 1). Same shape
// retained_audio_policy.dart uses next door: the mother class keeps one-line
// call sites, the bodies and the reasoning live here.
//
// 🔴 EVERY FUNCTION BELOW IS A NO-OP WHEN THE FLAG IS OFF — WITH ONE
// DELIBERATE EXCEPTION, [_journalTombstoneCancelled], WHICH RUNS IN TODAY'S
// PRODUCT. It has to: the defect card LS-4 closes (§A12 P1-5) is on the LEGACY
// face, which is the face that is on. Read its own doc before assuming the
// header sentence below still covers it.
//
// AND THE FLAG IS OFF IN PRODUCTION. `RetainedAudioSpill.retainFromFirstFrame` is false unless a
// caller passes true, and `retained_audio_boot.dart` does not. Read
// retained_audio_spill.dart's header for the five prerequisites §A10-0 lists
// before anybody may turn it on, and retained_audio_journal.dart's header for
// what the journal does and does not promise about durability.
//
// WHAT THE FIVE CALL SITES ARE, AND WHY EACH ONE EXISTS:
//   · start()             — open the journal. One recording, one journal.
//   · _emitChunk()        — every 200 ms chunk, from the FIRST frame. This is
//                           the line that closes E7: it does not consult the
//                           uplink, so an engine that died behind a healthy
//                           socket no longer costs the user their words.
//   · takeResidualChunk() — the sub-chunk partial at the end of a press. It is
//                           taken by the CALLER on the ordinary stop path
//                           (pttUp emits it ahead of audio:stop) and by
//                           stopForLinkLoss internally, so hooking the taker
//                           rather than the stoppers catches both.
//   · pause()             — the partial pause has always discarded. It is
//                           discarded from the WIRE for a good reason (it was
//                           never emitted); discarding it from the disk too
//                           was never a decision, just where the code fell.
//   · stop / stopForLinkLoss / fenceAndStop — close, with a named reason.
//   · fenceAndStop(reason: cancelled) — ALSO tombstone (card LS-4).
//
// 🔴 THE REASON IS STILL NOT THE TOMBSTONE, AND CARD LS-4 IS WHY THAT
// SENTENCE SURVIVED. LS-2 recorded `cancelled_or_fault` for all four
// `fenceAndStop` callers; LS-4 split that into four reasons and added a
// SEPARATE tombstone written on exactly one of them (owner ruling O-5,
// 2026-09-06). A capture fault and a swipe-up still share a stop verb and
// still do NOT share a disposition. SEG-2 §5-5 continues to freeze the
// RING-TAIL behaviour this file does not touch.

part of 'audio_capture.dart';

/// A recording is starting.
void _journalBeginRecording(AudioCapture c) {
  final RetainedAudioSpill? spill = c._spill;
  if (spill == null || !spill.retainFromFirstFrame) return;
  // Queued, not awaited: start() is on the press-latency path the owner
  // measured at ~2 s, and the spill serialises journal work, so the first
  // appendCaptured cannot overtake the open.
  unawaited(spill.beginRecording());
}

/// Captured PCM on its way to the ring — the first-frame write.
void _journalAppend(AudioCapture c, Uint8List bytes) {
  final RetainedAudioSpill? spill = c._spill;
  if (spill == null || !spill.retainFromFirstFrame) return;
  spill.appendCaptured(bytes);
}

/// The partial [AudioCapture.pause] is about to throw away.
///
/// 🔴 IT DOES NOT GO THROUGH `takeResidualChunk`. That verb pushes to the ring
/// and burns a seq, which is correct on a stop path (a reconnect replay must
/// include the tail) and wrong here: pause resumes, the wire never saw this
/// partial, and a seq spent on it would put a hole in a monotonic sequence the
/// server tracks. So the bytes are copied to the journal and the accumulator
/// is cleared exactly as before.
void _journalTakePausePartial(AudioCapture c) {
  final RetainedAudioSpill? spill = c._spill;
  if (spill == null || !spill.retainFromFirstFrame) return;
  if (c._accumulator.length <= 0) return;
  final Uint8List partial = c._accumulator.toBytes();
  spill.appendCaptured(partial);
}

/// Card LS-4 — the user cancelled: write the tombstone on BOTH faces.
///
/// 🔴 NOT GATED ON `retainFromFirstFrame`, unlike everything else in this
/// file, and the asymmetry is the card. The journal half inside
/// [RetainedAudioSpill.tombstoneCurrentRecording] is gated there; the LEGACY
/// half must run today, because today's product spills `<session>__seg-N.pcm`
/// during an outage and `BackfillRunner` was picking those up after a cancel.
///
/// Queued and unawaited for the same reason every teardown write here is: a
/// marker write must never be able to keep the microphone open (P1-1 ③).
/// `.catchError` because an unawaited rejection is an unhandled async error —
/// the spill already swallows its own, this covers the store's.
void _journalTombstoneCancelled(AudioCapture c) {
  final RetainedAudioSpill? spill = c._spill;
  if (spill == null) return;
  unawaited(spill
      .tombstoneCurrentRecording(sessionKey: c._retainSessionKey)
      .catchError((Object e) {
    debugPrint('[flowmic.audio] cancel tombstone failed: $e');
  }));
}

/// Card LS-1b — BANK THE FRAME COUNT WHILE IT IS STILL TRUE.
///
/// `_seq` is reset by the next `start()`, and the terminal final that compares
/// it against the server's `fed_frames` can arrive after the user has pressed
/// again. It is the capture's OWN counter — one increment per chunk pushed,
/// residual tail included — never a byte length divided by the frame size.
///
/// 🔴 CALLED FROM TWO PLACES, AND THE SECOND ONE IS A RACE FIX, NOT A COPY.
/// [_journalEndRecording] below is the general path; `stop()` ALSO calls it at
/// its very top, because `stop()` awaits `retainUnsentTail()` first and the
/// terminal `stt:final` can land inside that await — measured by
/// `ptt_up_final_race_test.dart` for the FSM half of the same race. A settle
/// that arrived before the count was banked would find no count and decline to
/// settle at all, which is safe and also permanent.
///
/// `closeWithFrames` keeps the FIRST value, so the two callers cannot disagree:
/// by the time `stop()` runs, `pttUp` has already taken and emitted the
/// residual chunk, so the count is final.
void _journalNoteFrames(AudioCapture c) {
  final RetainedAudioSpill? spill = c._spill;
  if (spill == null || !spill.retainFromFirstFrame) return;
  spill.noteLiveFramesEmitted(c._seq);
}

/// The recording ended; [interruptReason] says how (null = ordinary stop).
void _journalEndRecording(AudioCapture c, String? interruptReason) {
  final RetainedAudioSpill? spill = c._spill;
  if (spill == null || !spill.retainFromFirstFrame) return;
  _journalNoteFrames(c);
  unawaited(spill
      .endRecording(interruptReason: interruptReason)
      .catchError((Object e) {
    debugPrint('[flowmic.audio] journal close failed on stop: $e');
  }));
}
