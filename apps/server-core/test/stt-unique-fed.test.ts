// Codex review item 5 — `FedSeqRanges`, the 「has this chunk been handed to an engine
// before」 set the billing base now counts by (book 22 §4.9 correction).
//
// A property check against a plain Set, over random feeds shaped like the product's:
// mostly in order, holes where the gate withheld silence, and replays that re-hand an
// older span (a ladder reconnect, a rotation seam, an RC-5a / RC-E tail).

import { describe, expect, it } from 'vitest';
import { FedSeqRanges } from '../src/stt/unique-fed';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('Codex item 5 — FedSeqRanges answers 「first time?」 exactly like a Set', () => {
  it('random in-order feeds with holes and replays: every answer agrees with a Set', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed); const ranges = new FedSeqRanges(); const set = new Set<number>();
      let next = 0; let firsts = 0;
      for (let step = 0; step < 400; step++) {
        const roll = r();
        let seq: number;
        if (roll < 0.7) seq = next++;                                   // live, in order
        else if (roll < 0.8) { next += 1 + Math.floor(r() * 5); seq = next++; } // a withheld hole, then voice
        else seq = Math.max(0, next - 1 - Math.floor(r() * 30));         // a replay of something recent
        const want = !set.has(seq); set.add(seq);
        expect(ranges.firstFeed(seq), `seed ${seed} step ${step} seq ${seq}`).toBe(want);
        if (want) firsts++;
      }
      expect(firsts).toBe(set.size);
    }
  });

  it('a hole filled later (a withheld chunk replayed as a tail) counts once and joins its neighbours', () => {
    const f = new FedSeqRanges();
    for (const s of [0, 1, 2, 5, 6]) expect(f.firstFeed(s)).toBe(true);
    expect(f.firstFeed(4)).toBe(true);
    expect(f.firstFeed(3)).toBe(true);
    for (const s of [0, 1, 2, 3, 4, 5, 6]) expect(f.firstFeed(s)).toBe(false);
  });

  it('card RC-Q — `has` answers without recording, across holes and at both ends', () => {
    const f = new FedSeqRanges();
    for (const s of [3, 4, 5, 9, 10, 20]) f.firstFeed(s);
    for (const s of [3, 4, 5, 9, 10, 20]) expect(f.has(s)).toBe(true);
    for (const s of [0, 2, 6, 8, 11, 19, 21]) expect(f.has(s)).toBe(false);
    expect(f.firstFeed(6), '`has` recorded nothing').toBe(true);
  });
});
