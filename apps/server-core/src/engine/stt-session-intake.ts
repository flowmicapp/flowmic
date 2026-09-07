// SPEC-REF:
//   apps/server-core/src/engine/stt-session-receipt.ts (what the numbers are FOR)
//   apps/server-core/src/stt/orchestrator-core.ts (`ChunkIntake` — who decides)
//   apps/server-core/src/stt/audio/session.ts (`droppedChunks`, the other half)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b) — the coverage receipt
//
// One recording's frame tally: how many `audio:chunk` frames the pipeline took,
// and how many it turned away.
//
// ⚠️ IT LIVES BESIDE THE RECEIPT RATHER THAN IN THE BRIDGE, and the move is what
// let the counting rule be argued in one place instead of inferred from three
// `+= 1` statements scattered through `stt-session.ts` (which is also at 799 of
// the 800-line cap — verify/lint/file-size.mjs).
//
// 🔴 EVERY FRAME LANDS IN EXACTLY ONE BUCKET. `fed + dropped` must equal the
// number of frames the bridge was handed, because the phone compares `fed_frames`
// against its own send count to decide whether its local copy of the audio is
// still the only copy (card RC-1). A frame counted in both buckets, or in
// neither, makes that comparison answer a question nobody asked.

import type { ChunkIntake } from '../stt/orchestrator-core';

/**
 * owner 2026-07-27: "the phone app shows a prompt saying no speech was heard — is this a
 * mobile-side issue" — an empty transcript has two very different causes and the
 * banner cannot tell them apart. This tally can: chunks==0 means the phone sent
 * NOTHING (capture/permission/upload), while chunks>0 with peak≈0 means the mic
 * was live and the room was silent. Logged once per utterance, at finish.
 */
export class FrameTally {
  /** Frames the PIPELINE took: decoded by the bridge and accepted by the
   *  session. This is the receipt's `fed_frames`. */
  get fed(): number { return this._fed; }
  private _fed = 0;

  /** Frames that were taken off the wire and went nowhere. Card CV-1: the
   *  receipt adds `AudioSession.droppedChunks` to this — that counter owns the
   *  drops the session itself judged, this one owns everything refused before or
   *  around it. */
  get dropped(): number { return this._dropped; }
  private _dropped = 0;

  /** The bridge itself refused the frame: a disposed session, an undecodable
   *  base64 payload, an empty one. AudioSession never saw it. */
  noteBridgeDrop(): void { this._dropped += 1; }

  /**
   * Record what the pipeline did with a frame the bridge decoded.
   *
   * 🔴 `'deduped'` COUNTS AS FED, and that is not a rounding decision. The
   * orchestrator drops an already-observed seq ON PURPOSE — that is what makes a
   * reconnect's ring replay safe — so counting the mechanism working as audio
   * lost would make every reconnect look like damage. The frame's content IS in
   * the pipeline; it got there the first time.
   *
   * 🔴 `'refused'` IS A DROP even though nothing failed. A chunk that lands after
   * the orchestrator stopped accepting was received and went nowhere, and the
   * phone must be able to tell that from "the server consumed all of my audio".
   */
  note(verdict: ChunkIntake): void {
    if (verdict === 'refused') { this._dropped += 1; return; }
    this._fed += 1;
  }
}
