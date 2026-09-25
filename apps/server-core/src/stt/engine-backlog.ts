// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md `stt:interim` row (card RC-2, additive `acked_audio_ms`)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (card RC-2, network flush cap scales with backlog)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.5 / §1.6 / §5 RC-2
//
// Card RC-2 — the two facts the relay needs to say how far behind the vendor is,
// in one place, so the flush cap and the wire field read the same numbers.
//
// BACKLOG. Audio this leg was handed minus what the vendor reports processed
// (`SttEngine.ackedAudioMs`), both in the leg's own fed-audio clock. Null when
// the engine reports nothing: an unknown backlog is not a zero backlog, and the
// callers keep their pre-RC-2 behaviour on null.
//
// RECEIVED END. The end of the latest audio this recording has received, in the
// SENDER's clock (`audio:chunk.ts_ms` plus the chunk's own length). The phone's
// recovery feed stamps chunks with ms from the start of the range it is
// re-sending (`ptt_backfill.dart` `feedBackfillBlock`), so this is directly
// comparable with what it has sent.
//
// THE WIRE FIELD is `received end - backlog`. The phone subtracts it from its
// own sent end and gets exactly: audio still in transit or unread on this relay,
// plus the vendor's backlog. That is the quantity a paced feed must bound, and
// the reason it is a single position and not a backlog: a backlog alone cannot
// see the socket queue between the phone and us, which on CR-12-E held most of
// a 428 s recording within 4.3 s.
//
// ⚠️ It is NOT a promise about individual chunks. Silence the VAD gate withheld
// was never sent to the vendor and costs it nothing, so it counts as settled.

import { PCM_BYTES_PER_MS } from './tuning-env';

/** Unprocessed audio on the current leg, in ms; null = the engine reports no processed position. */
export function engineBacklogMs(engine: { readonly ackedAudioMs?: number } | null, legFedBytes: number): number | null {
  const acked = engine?.ackedAudioMs;
  if (typeof acked !== 'number' || !Number.isFinite(acked)) return null;
  return Math.max(0, legFedBytes / PCM_BYTES_PER_MS - acked);
}

/** The end of the latest audio received for one recording, in the sender's clock.
 *  One per orchestrator, which is one per `audio:start`, so it never needs a reset. */
export class ReceivedAudioEnd {
  private endMs: number | null = null;

  /** One chunk this recording took in (called for 'fed' intake only). */
  note(tsMs: number, bytes: number): void {
    if (!Number.isFinite(tsMs)) return;
    const end = tsMs + bytes / PCM_BYTES_PER_MS;
    if (this.endMs === null || end > this.endMs) this.endMs = end;
  }

  /** `{ acked_audio_ms }` for an `stt:interim`, or `{}` when either half is unknown. */
  wireField(backlogMs: number | null): { acked_audio_ms?: number } {
    if (this.endMs === null || backlogMs === null) return {};
    return { acked_audio_ms: Math.max(0, Math.round(this.endMs - backlogMs)) };
  }
}

/**
 * card RC-U (CR-12-E rerun-3 root cause §5, MAIN ruling 7) — the backlog above which two cut mechanisms
 * pause: the word-gap arm (its inputs, the hypothesis' last word and the processed position, are not to
 * be trusted while the vendor catches up — §5.1-3, a 600 ms pause read as ≥3 s) and the TIMED leg
 * rotation (break-before-make: every rotation re-feeds the next leg what the old one spent flushing, so a
 * backlog is MOVED from leg to leg instead of drained — §5.1, measured flush 18.6 → 14.0 → 29.6 s and the
 * next replay ≈ the previous flush each time). The gate's silence hang-up, the sentence and pause arms,
 * the overdue arm, the vendor-session ceiling (N1-B4) and the NR-60 decode budget are untouched.
 * 5 s is the card's number: the replay window, i.e. the audio a rotation re-feeds on a healthy leg.
 */
export const BACKLOG_HOLDS_CUT_ARMS_MS = 5_000;

/** card RC-U — [backlogMs] from {@link engineBacklogMs}; null (the engine reports nothing) never holds. */
export function backlogHoldsCutArms(backlogMs: number | null): boolean {
  return backlogMs !== null && backlogMs > BACKLOG_HOLDS_CUT_ARMS_MS;
}
