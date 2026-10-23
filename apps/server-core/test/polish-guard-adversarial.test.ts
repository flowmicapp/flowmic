// NR-245 (GUARD-2) — the two QP-1 adversarial review rounds, kept as a fixture.
//
// Every pair is judged at BOTH strengths and the verdict is pinned. A pair
// labelled `harmful` that the guard still accepts carries `known_hole: true`:
// the test then asserts the ACCEPT, so the hole is documented rather than
// hidden, and closing it means flipping the row (known_hole false, expect
// refuse) and watching this test go red on the unfixed guard first.
//
// Labels come from the review rounds (H = meaning change or content loss,
// N = a legitimate edit). A neutral pair the guard refuses is pinned as a
// refusal too: that is a cost, not a hole, and it is visible here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';

type Verdict = 'accept' | 'refuse';
interface Row {
  id: string;
  category: string;
  label: 'harmful' | 'neutral';
  input: string;
  output: string;
  expect: { strict: Verdict; smooth: Verdict };
  known_hole: boolean;
}

const rows: Row[] = readFileSync(join(__dirname, 'fixtures', 'polish-guard-adversarial.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);

describe('polish guard adversarial fixture (QP-1 review rounds)', () => {
  it('has both review rounds', () => {
    expect(rows.length).toBe(129);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('known_hole is exactly "harmful and accepted at some strength"', () => {
    for (const r of rows) {
      const accepted = r.expect.strict === 'accept' || r.expect.smooth === 'accept';
      expect({ id: r.id, known_hole: r.known_hole }).toEqual({ id: r.id, known_hole: r.label === 'harmful' && accepted });
    }
  });

  for (const r of rows) {
    for (const strength of ['strict', 'smooth'] as const) {
      it(`${r.id} ${r.category} ${strength}${r.known_hole ? ' (known hole)' : ''}: ${r.input.slice(0, 40)} -> ${r.output.slice(0, 40)}`, () => {
        const got = checkMeaningPreserved(r.input, r.output, { strength });
        expect({ id: r.id, strength, verdict: got.ok ? 'accept' : 'refuse', reason: got.reason })
          .toMatchObject({ id: r.id, strength, verdict: r.expect[strength] });
      });
    }
  }
});
