// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (RC-Q correction: the managed-streaming base
//     counts audio the VAD gate ACCEPTED and an engine ANSWERED, each chunk once)
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.1, §11 (the two mechanisms of Q2(a): Codex's
//     「fed into a dying leg」 and opus's 「outage silence replayed as unique fed」 — both fixed here)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// card RC-Q — WHICH AUDIO THE BILL COUNTS. Until this card the second term of
// `min(gate-open ms, …)` (`engine/stt-session.ts settle`) counted a chunk the first time it was PUSHED to
// any leg (Codex item 5, `unique-fed.ts`). Two things made that number larger than 「audio a vendor heard
// for the user」, and each was measured on the device (S4 / S5: 5 s billed for a hole nobody heard):
//   ① A push is not a hearing. A leg that dies has been handed 1–2 s it never answered (up to 20 s while
//     the vendor catches up a backlog); that audio is billed here and billed AGAIN when the phone
//     re-transcribes it in a recovery session (Codex, rerun-3 Q2(a)).
//   ② A push is not voice. During an engine outage every chunk waits for the replay, silence included
//     (HANGUP-1 keeps the mark still), and the ladder's replay hands all of it to the new leg; the gate
//     had refused those chunks, but their first push counted them. That lifted the second term above the
//     gate-open time, so `min` fell back to the gate-open time — which includes the hole (opus, §2.1,
//     scratch reading `billed 74280 / heard voice 70200`). The RC-5a / RC-E / RC-T tails are the same.
//
// THE RULE: a chunk is counted once, the first time (a) the gate ACCEPTED it at intake and (b) a leg it
// was handed has ANSWERED past its end — the vendor's processed position (`SttEngine.ackedAudioMs`) has
// reached the end of that chunk in the leg's own fed-audio clock. An engine that reports no processed
// position is unknown, not zero: its chunks count when they are handed over, exactly as before (every
// engine but Soniox). Audio a dying leg never answered is dropped with the leg and counted when a later
// leg (a replay) answers it — or never, if no leg does, in which case the phone owes it and its recovery
// session bills it. Soniox reports its position rounded UP to a 120 ms step (`SONIOX_PROC_STEP_MS`), so
// a chunk can count up to one step before the vendor has finished it; at end-of-stream the position
// covers everything sent, so a finished leg counts in full.

import { FedSeqRanges } from './unique-fed';
import { PCM_BYTES_PER_MS } from './tuning-env';

interface PendingChunk { readonly seq: number; readonly bytes: number; readonly endMs: number }

export class HeardAudioLedger {
  /** Seqs the VAD gate accepted at intake (`pushChunk`'s one `feed` reading). */
  private readonly accepted = new FedSeqRanges();
  /** Seqs already counted — each chunk once, whichever leg answered it first. */
  private readonly counted = new FedSeqRanges();
  /** Chunks handed to the CURRENT leg that it has not answered yet, in the leg's clock. */
  private pending: PendingChunk[] = [];
  private countedBytes = 0;

  /** A fresh recording. */
  reset(): void { this.accepted.reset(); this.counted.reset(); this.pending = []; this.countedBytes = 0; }

  /** The gate accepted [seq] (the same reading that decides the live push). */
  noteAccepted(seq: number): void { this.accepted.firstFeed(seq); }

  /** One chunk handed to the current leg; [legEndMs] is where it ends in that leg's fed-audio clock. */
  noteFed(seq: number, bytes: number, legEndMs: number): void { this.pending.push({ seq, bytes, endMs: legEndMs }); }

  /** Count every pending chunk the current leg has answered. [ackedMs] undefined ⇒ the engine reports
   *  no processed position ⇒ every pending chunk counts (the pre-RC-Q rule for such engines). */
  settle(ackedMs: number | undefined): void {
    const known = typeof ackedMs === 'number' && Number.isFinite(ackedMs);
    let keep = 0;
    for (const p of this.pending) {
      if (known && p.endMs > ackedMs) { this.pending[keep++] = p; continue; }
      if (this.accepted.has(p.seq) && this.counted.firstFeed(p.seq)) this.countedBytes += p.bytes;
    }
    this.pending.length = keep;
  }

  /** The current leg is closing: count what it answered; what it did not is dropped with it (a replay
   *  into the next leg hands those chunks over again, and they count when that leg answers them). */
  endLeg(ackedMs: number | undefined): void { this.settle(ackedMs); this.pending = []; }

  /** Billable ms as of now, reading the current leg's position without spending anything. */
  billableMs(ackedMs: number | undefined): number {
    const known = typeof ackedMs === 'number' && Number.isFinite(ackedMs);
    let bytes = this.countedBytes;
    const seen = new Set<number>();
    for (const p of this.pending) {
      if (known && p.endMs > ackedMs) continue;
      if (this.accepted.has(p.seq) && !this.counted.has(p.seq) && !seen.has(p.seq)) { seen.add(p.seq); bytes += p.bytes; }
    }
    return bytes / PCM_BYTES_PER_MS;
  }
}
