// GUARD-CJK (2026-10-15): content words in Han / kana / Hangul / Cyrillic and
// name swaps (stt-polish-guard-cjk.ts, stt-polish-guard-names.ts).
//
// Every `refuse` row was accepted by the guard before this card at one strength
// at least (the holes the NR-262 reviews found, plus one row per rule); every `accept` row is a correct
// polish the new rules must leave alone, at both strengths. open_hole rows are
// harmful Han content swaps main also accepts; `only: smooth` rows are ones the
// strict edit budget refuses on main as well (unchanged by this card); they stay accepted until the
// reading-table follow-up (ledger) can tell them from same-reading repairs. Several accept rows
// are real model outputs from the recorded runs (ko 계획이 -> 계획에, ru
// бэкинг -> бэкенд, ja 僕って -> 作って, de Blocks -> Blogs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import { TRAD_SIMP_PAIR_LIST } from '../src/stt/stt-polish-guard-cjk-tables';

interface Row { id: string; lang: string; want: 'accept' | 'refuse'; kind: string; input: string; output: string; open_hole?: true; only?: 'smooth' }

const rows: Row[] = readFileSync(join(__dirname, 'fixtures', 'polish-guard-cjk.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);

describe('polish guard: Han / kana / Hangul / Cyrillic content and names (GUARD-CJK)', () => {
  it('has both sides for every script', () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const prefix of ['cjk-zh', 'cjk-ja', 'cjk-ko', 'cjk-ru', 'name-']) {
      expect(rows.some((r) => r.id.startsWith(prefix) && r.want === 'refuse')).toBe(true);
      expect(rows.some((r) => r.id.startsWith(prefix) && r.want === 'accept')).toBe(true);
    }
  });

  it('the open holes are exactly the Han content swaps a reading table would judge', () => {
    expect(rows.filter((r) => r.open_hole).map((r) => r.id)).toEqual(['cjk-zh-h07', 'cjk-zh-h08', 'cjk-zh-h13', 'cjk-ja-h03', 'cjk-ja-h04']);
  });

  for (const r of rows) {
    for (const strength of ['strict', 'smooth'] as const) {
      if (r.only !== undefined && r.only !== strength) continue;
      it(`${r.id} ${r.kind} ${strength} ${r.want}: ${r.input.slice(0, 30)} -> ${r.output.slice(0, 30)}`, () => {
        const got = checkMeaningPreserved(r.input, r.output, { strength, language: r.lang });
        const pinned = r.open_hole === true ? 'accept' : r.want;
        expect({ id: r.id, strength, verdict: got.ok ? 'accept' : 'refuse', reason: got.reason })
          .toMatchObject({ id: r.id, strength, verdict: pinned });
        if (pinned === 'refuse') expect(got.reason ?? '').toMatch(/^closed-class-drift:/u);
      });
    }
  }

  it('the simplified / traditional table pairs each character once', () => {
    const seen = new Set<string>();
    for (const pair of TRAD_SIMP_PAIR_LIST) {
      const chars = [...pair];
      expect({ pair, n: chars.length, differ: chars[0] !== chars[1] }).toEqual({ pair, n: 2, differ: true });
      for (const c of chars) {
        expect({ pair, c, dup: seen.has(c) }).toEqual({ pair, c, dup: false });
        seen.add(c);
      }
    }
  });
});
