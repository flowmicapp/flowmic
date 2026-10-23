// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.2 (card SEAM-2 block, 「下一行首词回小写」)
//
// Card SEAM-2 (re-review R3, MAIN 2026-10-15) — the bridge's half of the next-row lower-casing.
//
// The orchestrator knows that row N's cut was stripped open (`stt/seam-artifact.ts` OpenSeamCarry) and tags the
// next final with `seam_from: N`. It does NOT know what row N finally said: the segment polish may keep a
// terminal mark on it (「We need about 5.」 — a dot that belongs to the number), and lower-casing row N+1 after
// that reads 「5. the boat leaves」. The source of truth is the text this bridge DELIVERED for row N
// (`SttSessionBridge.emitFinal`, the one exit for `stt:final`). So: lower-case N+1's first closed word only when
// row N has been delivered and its delivered text does not end in a terminal mark. Row N still in flight (its
// polish holding the ordered outbox) ⇒ not delivered yet ⇒ the capital stays (MAIN: don't guess).

import { lowerContinuationHead } from '../stt/seam-artifact';

/** A delivered row ending a sentence (closing quotes and brackets looked through). */
const ENDS_TERMINAL = /[.?!。？！…][”’"'）)\]】」』》]*$/u;

export class DeliveredSeam {
  /** The last soft-segment row that left through `emitFinal`, by index. */
  private last: { idx: number; text: string } | null = null;

  /** Called from `emitFinal` for every frame that goes out. */
  noteDelivered(text: string, rest: Record<string, unknown>): void {
    if (rest.is_segment === true && typeof rest.segment_idx === 'number') this.last = { idx: rest.segment_idx, text };
  }

  /** The raw text of a final whose orchestrator frame says it continues row [seamFrom]. */
  head(raw: string, seamFrom: unknown, language: string): string {
    if (typeof seamFrom !== 'number' || this.last === null || this.last.idx !== seamFrom) return raw;
    if (ENDS_TERMINAL.test(this.last.text.trimEnd())) return raw;
    return lowerContinuationHead(raw, language);
  }
}
