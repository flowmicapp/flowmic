// SPEC-REF:
//   docs/strategy/2026-08-11 SEG-2 design §2-R3 (the production construction of
//     the retained-audio layer)
//   apps/mobile/lib/src/audio/retained_audio_dir.dart (the orphan backstop every
//     opener is asked to run)
//   CLAUDE.md red line: no silent failure — a degradation is declared, never
//     discovered later
//
// 🔴 THIS IS `main()`'s RETAINED-AUDIO BLOCK, MOVED VERBATIM. Not rewritten,
// not tidied, not re-argued: the body below is the same statements in the same
// order carrying the same comments, and the reason for the move is the 800-line
// source cap (`verify:lint file-size`), which main.dart crossed on 2026-08-27.
// The repo's own precedent for that cap is a STRUCTURAL split — take a coherent
// family out whole — rather than trimming the evidence a comment carries
// (`bootstrap.ts`/`shutdown.ts`, IT-02). Nothing here is new behaviour.
//
// The family is coherent because it answers one question end to end: 「is there
// a retained-audio spill for this run, and if not, what does the app become?」

import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;

import '../diag/diag_log.dart' show diag;
import 'retained_audio_dir.dart';
import 'retained_audio_spill.dart';
import 'retained_audio_store.dart';

/// Card RC-1 — the shipped value of [openRetainedAudioSpill]'s
/// [retainFromFirstFrame], named so a test can assert against the SAME symbol
/// production reads rather than against a literal that agrees with itself.
///
/// 🔴 IT IS THE REVERSE CONTROL'S ONE SWITCH: flipping this to `false` must
/// turn `test/retained_audio_ls0_gaps_test.dart`'s E7 case red, which is what
/// makes that case a measurement of production and not of its own fixture.
const bool kRetainFromFirstFrameDefault = true;

/// Open the retained-audio layer for this run, or `null`.
///
/// SEG-2 (design 2026-08-11 §2-R3) — THE PRODUCTION CONSTRUCTION OF THE
/// RETAINED-AUDIO LAYER. The layer shipped complete (N1-B3) and constructed
/// by nothing: Book 15 §2.0-b's correction block measured this exact absence,
/// so production wrote zero bytes while every retention test was green.
/// Opened from `main()` — the directory comes from path_provider, which is
/// async, and PttSession's construction (initState) is not — and handed down as
/// the DEFAULT capture's spill.
///
/// ⚠️ Failure direction: an open failure must not take the app down over its
/// own safety net. null degrades to the pre-SEG-2 product (no retention),
/// LOUDLY — and ptt_link_loss.dart then refuses to claim retention in the
/// user-facing notice, so the degradation never becomes an unbacked promise.
/// 🔴 CARD RC-1 (2026-09-06) — FIRST-FRAME RETENTION IS THE SHIPPED DEFAULT.
///
/// [retainFromFirstFrame] chooses which storage face the returned spill runs
/// (retained_audio_spill.dart's header describes both). **The default is
/// [kRetainFromFirstFrameDefault], which is now `true`.** Every build shipped
/// from this commit writes a per-recording journal from the first captured
/// frame, whatever the uplink is doing; the segment face survives only so
/// journals written before this flip are still recovered by the same runner.
///
/// The parameter stays because the legacy face still has to be exercised —
/// `test/retained_audio_first_frame_test.dart` drives both — not because a
/// build may choose. There is exactly one production construction and it takes
/// the default.
///
/// 🔴 THE FIVE THINGS §A10-0 REQUIRED BEFORE THIS COULD BE TRUE, AND WHERE
/// EACH ONE LANDED (read before rolling this back — turning it off gives the
/// audio back to a 30-second ring):
///   ① write-failure release (P1-1, card LS-1b) — a failed append is contained
///      per link, recorded as a hole and announced, so the queue is not
///      poisoned and the microphone can still stop:
///      apps/mobile/lib/src/audio/retained_audio_legacy_face.dart:66 `_appendOne`;
///   ② cancel semantics (owner ruling O-5, card LS-4) — a swiped-away
///      recording gets a tombstone on both faces and loses no byte:
///      apps/mobile/lib/src/audio/retained_audio_spill.dart:481
///      `tombstoneCurrentRecording`;
///   ③ space policy (owner ruling O-2, card LS-3) — the cap refuses new bytes
///      and says so instead of evicting unrecovered audio:
///      apps/mobile/lib/src/audio/retained_audio_store.dart:507 `_capBytes`;
///   ④ a live-path settle call site (P1-4, card LS-1b) — the healthy recording
///      that simply worked now has an exit:
///      apps/mobile/lib/src/session/live_settle.dart:59 `settleLiveRecording`,
///      called from `_settleSpan` in
///      apps/mobile/lib/src/session/chat_utterance_settle.dart:208;
///   ⑤ the coverage / cleanup policy (A7-1, card CV-1; owner ruling
///      2026-09-06) — one predicate decides what proof licenses a delete, and
///      both the live path and the recovery leg ask it:
///      apps/mobile/lib/src/session/recovery_settle.dart:209
///      `evaluateRecoverySettle`.
///
/// ⚠️ The warning the OFF-by-default note carried is now a live obligation
/// rather than a reason to wait: this ships a protection that grows, and ④+⑤
/// are the only things that shrink it. A change that weakens either one is a
/// change that fills the user's disk.
Future<RetainedAudioSpill?> openRetainedAudioSpill({
  bool retainFromFirstFrame = kRetainFromFirstFrameDefault,
}) async {
  try {
    final RetainedAudioStore retainedStore = await openRetainedAudioStore();
    // Retention events must be heard (store contract: 「no silent failures」 runs in
    // both directions). The diagnostics log is the minimum surface the store's
    // own doc names; listener attached BEFORE the sweep so expiry notices from
    // a previous run's orphans are not announced into the void.
    //
    // 🔴 F6 (2026-09-02 audit) — THIS WAS THE ONLY LISTENER, PERIOD, and the
    // store's own header already required more ("callers MUST surface
    // these"). `retainedStore.lastNotice` (a `ValueListenable`, set on every
    // announcement regardless of who is subscribed here) plus
    // `RecordingStrings.retainedAudioNoticeMessage` now give a future UI
    // layer everything it needs to show the sentence — no stream subscription
    // race, no missing translation. Actually putting it on screen is banner-
    // queue work (`session/chat_notices.dart` / `ui/banner_queue.dart`) and
    // does not belong in this bootstrap file; until that lands, this diag
    // line remains the only OBSERVED surface, which is the honest thing to
    // say about it here.
    retainedStore.notices.listen(
      (RetainedAudioNotice n) =>
          diag('audio.retained.notice', <String, Object?>{
        'code': n.code,
        'segment': n.segmentIdx,
        'bytes': n.bytes,
      }),
    );
    // The orphan backstop retained_audio_dir.dart asks every opener to run:
    // audio no session can ever claim again ages out, announced on the way.
    unawaited(retainedStore.sweep());
    return RetainedAudioSpill(
      store: retainedStore,
      retainFromFirstFrame: retainFromFirstFrame,
    );
  } on Object catch (e) {
    debugPrint('[flowmic.audio] retained-audio store failed to open: $e — '
        'link-loss retention is DISABLED for this run');
    return null;
  }
}
