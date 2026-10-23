// ML-1 — the ML-0 multilingual adversarial pairs (fr / es / de / ja / ko / ru),
// kept as a fixture beside the en/zh one (polish-guard-adversarial.test.ts).
//
// Source: scripts/eval/speech-quality/guard-pairs-ml.jsonl (card ML-0), copied
// row for row. `ideal` is the ML-0 expectation (harmful -> refuse at both
// strengths, neutral -> accept; `any` where strict may legitimately keep a
// filler or a self-correction). `expect` is the verdict this guard is pinned
// to. The two differ only where a row says so:
//   · known_hole — a harmful pair accepted at some strength;
//   · known_cost — a neutral pair refused at some strength.
// Closing a hole or a cost means flipping `expect` toward `ideal` and watching
// this test go red on the unfixed guard first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';

type Verdict = 'accept' | 'refuse';
interface Row {
  id: string;
  lang: string;
  kind: string;
  label: 'harmful' | 'neutral';
  input: string;
  output: string;
  ideal: { strict: Verdict | 'any'; smooth: Verdict | 'any' };
  expect: { strict: Verdict; smooth: Verdict };
  known_hole: boolean;
  known_cost: boolean;
}

const rows: Row[] = readFileSync(join(__dirname, 'fixtures', 'polish-guard-multilingual.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);

describe('polish guard multilingual fixture (ML-0 pairs)', () => {
  it('has every ML-0 pair', () => {
    expect(rows.length).toBe(133);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('known_hole / known_cost are exactly where expect departs from ideal', () => {
    for (const r of rows) {
      const off = (s: 'strict' | 'smooth'): boolean => r.ideal[s] !== 'any' && r.ideal[s] !== r.expect[s];
      const departs = off('strict') || off('smooth');
      expect({ id: r.id, flagged: r.known_hole || r.known_cost }).toEqual({ id: r.id, flagged: departs });
      expect({ id: r.id, hole: r.known_hole }).toEqual({ id: r.id, hole: r.label === 'harmful' && departs });
    }
  });

  for (const r of rows) {
    for (const strength of ['strict', 'smooth'] as const) {
      const tag = r.known_hole ? ' (known hole)' : r.known_cost ? ' (known cost)' : '';
      it(`${r.id} ${r.kind} ${strength}${tag}: ${r.input.slice(0, 36)} -> ${r.output.slice(0, 36)}`, () => {
        const got = checkMeaningPreserved(r.input, r.output, { strength, language: r.lang });
        expect({ id: r.id, strength, verdict: got.ok ? 'accept' : 'refuse', reason: got.reason })
          .toMatchObject({ id: r.id, strength, verdict: r.expect[strength] });
      });
    }
  }
});
