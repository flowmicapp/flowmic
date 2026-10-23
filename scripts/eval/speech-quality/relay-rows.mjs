// scripts/eval/speech-quality/relay-rows.mjs — how the simulated phone in
// run-relay.mjs turns `stt:final` frames into timeline rows (card POL-2).
//
// Mirrors the realtime-mode settlement of apps/mobile at the time of writing:
//   · the segment buffer keeps one text per `segment_idx`, a later final for
//     the same idx replacing the earlier one (stt/segment_buffer.dart);
//   · a soft-segment final (`is_segment:true`) settles the span from the first
//     unsettled idx through its own idx as ONE row, unless that span is empty,
//     in which case nothing settles and the watermark does not move
//     (session/chat_utterance.dart, the `if (f.isSegment)` branch);
//   · a final whose idx is below the watermark settles nothing;
//   · the terminal final (`is_segment:false`) settles whatever is left as the
//     last row (the same file, "Terminal final closes the utterance").
// Only realtime mode is modelled: translate/organize settle once per press
// (`_settlesPerSegment` in chat_utterance_settle.dart), and the eval relay is
// always started in realtime mode.
//
// NOT A GATE. Pure functions; the unit test is scripts/pol2-two-stage-scoring.test.mjs.

const isCjkChar = (ch) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch ?? '');

/** stt/segment_buffer.dart `joinedFrom` + `_joinerBetween`: no joiner next to
 *  CJK or existing whitespace. `from` = the first segment_idx to include. */
export function joinSegments(map, from = -Infinity) {
  let s = '';
  for (const k of [...map.keys()].sort((a, b) => a - b)) {
    if (k < from) continue;
    const t = map.get(k) ?? '';
    if (!t) continue;
    if (!s) { s = t; continue; }
    const a = s[s.length - 1], b = t[0];
    s += (/\s/.test(a) || /\s/.test(b) || isCjkChar(a) || isCjkChar(b)) ? '' : ' ';
    s += t;
  }
  return s;
}

/** Joins row texts the way the receiving side sees consecutive rows (the same
 *  joiner rule as segments). */
export const joinRows = (texts) => joinSegments(new Map(texts.map((t, i) => [i, t])));

/** One press's settlement. `onFinal(payload)` returns the row it settled, or null. */
export class RowSettler {
  constructor() { this.segs = new Map(); this.next = 0; this.rows = []; this.closed = false; }

  onFinal(f) {
    const idx = f.segment_idx ?? 0;
    this.segs.set(idx, f.text ?? '');
    if (this.closed) return null;
    const terminal = f.is_segment === false;
    if (idx < this.next) { if (terminal) this.closed = true; return null; }
    const text = joinSegments(this.segs, this.next);
    if (!terminal && !text.trim()) return null;
    const row = { idx: this.rows.length, from_seg: this.next, to_seg: idx, terminal, text, polish: f.polish ?? null, polish_reason: f.polish_reason ?? null };
    this.next = idx + 1;
    if (terminal) this.closed = true;
    this.rows.push(row);
    return row;
  }
}
