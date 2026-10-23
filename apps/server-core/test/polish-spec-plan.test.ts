// Card INC-1d — the pure planner of "polish while speaking"
// (src/stt/polish-spec-plan.ts; design §2.2, D3, §3.1, §7.1 T1/T2/T5).

import { describe, expect, it } from 'vitest';
import { assemble, closedPieces, contextOf, CONTEXT_MAX, MAX_PIECE, MIN_PIECE, planRelease, reconstructs, sentenceEnds, type SpecEntry } from '../src/stt/polish-spec-plan';

/** Deterministic PRNG so a red run can be replayed. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000; };
}
const LATIN = ['so', 'we', 'need', 'the', 'numbers', 'Dr.', 'v2.5', 'e.g.', 'okay', 'third', 'quarter', 'and', 'then', 'U.S.', '3.5', 'release'];
const CJK = ['我们', '需要', '看一下', '第三季度', '的', '数字', '然后', '发布', '这个', '版本'];
function randomText(r: () => number, kind: 'latin' | 'cjk' | 'mixed', words: number): string {
  let s = '';
  for (let i = 0; i < words; i++) {
    const cjk = kind === 'cjk' || (kind === 'mixed' && r() < 0.5);
    const w = cjk ? CJK[Math.floor(r() * CJK.length)]! : LATIN[Math.floor(r() * LATIN.length)]!;
    s += cjk ? w : (s === '' ? '' : ' ') + w;
    const p = r();
    if (p < 0.08) s += cjk ? '。' : '.'; else if (p < 0.1) s += cjk ? '？' : '?'; else if (p < 0.16) s += cjk ? '，' : ',';
    else if (p < 0.17) s += '”';
  }
  return s;
}
const texts = (s: string, spans: { start: number; end: number }[]): string[] => spans.map((p) => s.slice(p.start, p.end));

describe('INC-1d sentence ends', () => {
  it('Latin: a period ends a sentence only before whitespace, not after an abbreviation, a number or one letter', () => {
    const s = 'Dr. Smith paid 3.5 dollars. A. Then e.g. this! Next';
    expect(sentenceEnds(s).map((e) => s.slice(0, e))).toEqual(['Dr. Smith paid 3.5 dollars.', 'Dr. Smith paid 3.5 dollars. A. Then e.g. this!']);
  });
  it('CJK ends and closers; the last end needs a following character unless final', () => {
    const s = '他说“好的。”然后走了。';
    expect(sentenceEnds(s)).toEqual([7]);
    expect(sentenceEnds(s, 0, true)).toEqual([7, 12]);
  });
});

describe('INC-1d pieces', () => {
  it('groups whole sentences to at least MIN_PIECE code points', () => {
    const one = 'This is a short sentence of about forty chars. ';
    const s = one.repeat(4) + 'tail';
    const p = texts(s, closedPieces(s));
    expect(p.length).toBe(2);
    for (const x of p) expect([...x].length).toBeGreaterThanOrEqual(MIN_PIECE);
    expect(p[0]).toBe((one + one).trim());
  });
  it('an over-long run splits at its last weak mark; an unpunctuated one stays open', () => {
    const run = '一二三四五六七八九十'.repeat(30); // 300 code points, no mark at all
    expect(closedPieces(run + '。下一句')).toEqual([]);
    const marked = '一二三四五六七八九十'.repeat(12) + '，' + '一二三四五六七八九十'.repeat(18) + '。后面';
    const p = texts(marked, closedPieces(marked));
    expect(p[0]!.endsWith('，')).toBe(true);
    expect([...p[0]!].length).toBeLessThanOrEqual(MAX_PIECE);
  });
  it('🔴 T1 prefix-stable: the closed pieces of every prefix are a prefix of the closed pieces of the whole', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const kind = (['latin', 'cjk', 'mixed'] as const)[seed % 3]!;
      const s = randomText(r, kind, 40 + Math.floor(r() * 160));
      const whole = closedPieces(s);
      for (let n = 1; n <= s.length; n += 1 + Math.floor(r() * 3)) {
        const pre = closedPieces(s.slice(0, n));
        expect(pre, `seed ${seed} n ${n}`).toEqual(whole.slice(0, pre.length));
      }
    }
  });
});

describe('INC-1d context', () => {
  it('is the whole un-polished prefix when short, and starts at a sentence start when cut', () => {
    expect(contextOf('One. Two three. Four', 16)).toBe('One. Two three.');
    const long = 'First sentence here. '.repeat(12) + 'X';
    const c = contextOf(long, long.length - 1);
    expect([...c].length).toBeLessThanOrEqual(CONTEXT_MAX);
    expect(c.startsWith('First sentence here.')).toBe(true);
  });
});

describe('INC-1d release plan', () => {
  const entryAt = (p: string, input: string, from = 0): SpecEntry => ({ input, context: contextOf(p, p.indexOf(input, from)) });

  it('🔴 T2 reconstructs: inputs + joints re-join to exactly P, for random plans with real, stale and garbage entries', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const r = rng(seed * 7);
      const p = randomText(r, (['latin', 'cjk', 'mixed'] as const)[seed % 3]!, 60 + Math.floor(r() * 120));
      const pieces = texts(p, closedPieces(p));
      const entries: SpecEntry[] = [];
      for (const x of pieces) {
        if (r() < 0.7) entries.push(entryAt(p, x));
        if (r() < 0.2) entries.push({ input: x, context: 'stale context' });
        if (r() < 0.1) entries.push({ input: 'garbage that is not there', context: '' });
      }
      const plan = planRelease(p, entries);
      expect(reconstructs(p, plan), `seed ${seed}`).toBe(true);
      expect(assemble(plan, (s) => s.input)).toBe(p);
      if (entries.length > 0 && pieces.length > 0) expect(plan.some((s) => s.kind === 'hit') || entries.every((e) => e.context === 'stale context' || e.input.startsWith('garbage'))).toBe(true);
    }
  });

  it('a hit needs the same context; a sentence said twice matches the occurrence with that context', () => {
    const p = 'We ship today. Then we test. We ship today. Done';
    const second = p.indexOf('We ship today.', 1);
    const plan = planRelease(p, [{ input: 'We ship today.', context: contextOf(p, second) }]);
    const hit = plan.find((s) => s.kind === 'hit');
    expect(hit && hit.kind === 'hit' ? hit.at : -1).toBe(second);
    expect(planRelease(p, [{ input: 'Then we test.', context: 'something else' }]).some((s) => s.kind === 'hit')).toBe(false);
  });

  it('🔴 T5 mismatch safety: a stable prefix that was re-folded at release is a miss and the gap is polished, never a wrong text', () => {
    const speech = 'The first part is here and it is long enough to close. The second part follows. ';
    const piece = texts(speech, closedPieces(speech))[0]!;
    const final = 'The first part is here and it is long enough to clothes. The second part follows.'; // re-folded word
    const plan = planRelease(final, [{ input: piece, context: '' }]);
    expect(plan.some((s) => s.kind === 'hit')).toBe(false);
    expect(plan).toEqual([{ kind: 'polish', input: final, at: 0, context: '' }]);
  });

  it('the one-span case: no entry ⇒ one polish span over all of P with empty context (the legacy call)', () => {
    expect(planRelease('  hello there ', [])).toEqual([
      { kind: 'joint', text: '  ' }, { kind: 'polish', input: 'hello there', at: 2, context: '' }, { kind: 'joint', text: ' ' }]);
  });
});
