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
Future<RetainedAudioSpill?> openRetainedAudioSpill() async {
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
    return RetainedAudioSpill(store: retainedStore);
  } on Object catch (e) {
    debugPrint('[flowmic.audio] retained-audio store failed to open: $e — '
        'link-loss retention is DISABLED for this run');
    return null;
  }
}
