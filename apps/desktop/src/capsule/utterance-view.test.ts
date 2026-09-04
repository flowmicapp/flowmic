// Fixture-driven parity for the utterance view (desktop half).
//
// The fixture is READ, not restated: verify/fixtures/utterance-view-parity.json
// is the same bytes apps/mobile/test/utterance_view_parity_test.dart loads. A
// test that copied the expectations into this file would go green while the two
// ends disagreed, which is the whole failure this pair exists to catch.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UtteranceView, joinerBetween } from './utterance-view';

interface Step {
  frame: 'audio:start' | 'stt:interim' | 'stt:final';
  idx?: number;
  text?: string;
  is_segment?: boolean;
  note?: string;
  committed: string;
  pending: string;
  display: string;
}
interface Scenario {
  name: string;
  mode: string;
  steps: Step[];
}

const FIXTURE = resolve(__dirname, '../../../../verify/fixtures/utterance-view-parity.json');
const scenarios: Scenario[] = (
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as { scenarios: Scenario[] }
).scenarios;

describe('utterance view — fixture parity with the phone', () => {
  it('the fixture is actually loaded (a silently empty file must not pass)', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(5);
    for (const s of scenarios) expect(s.steps.length).toBeGreaterThan(1);
  });

  for (const s of scenarios) {
    it(s.name, () => {
      const view = new UtteranceView();
      s.steps.forEach((step, i) => {
        const where = `${s.name} · step ${i} (${step.frame}${step.note ? ` — ${step.note}` : ''})`;
        if (step.frame === 'audio:start') view.reset(s.mode);
        else if (step.frame === 'stt:interim') view.onInterim(step.idx!, step.text!);
        else view.onFinal(step.idx!, step.text!, step.is_segment === true);
        expect(view.committed, `committed @ ${where}`).toBe(step.committed);
        expect(view.pending, `pending @ ${where}`).toBe(step.pending);
        expect(view.display, `display @ ${where}`).toBe(step.display);
        // The colour split may never claim characters the display does not have.
        expect(view.display.slice(0, view.committedChars).trimEnd()).toBe(
          step.committed,
        );
      });
    });
  }
});

describe('utterance view — the rules the fixture cannot show twice', () => {
  it('a replayed FINAL for a closed slot changes nothing', () => {
    const v = new UtteranceView();
    v.reset('translate');
    v.onFinal(0, 'first.', true);
    expect(v.onFinal(0, 'something else', true)).toBe(false);
    expect(v.display).toBe('first.');
  });

  it('an unfinalised gap keeps the later closed slot GREY, never black', () => {
    const v = new UtteranceView();
    v.reset('translate');
    v.onInterim(0, 'still open');
    v.onFinal(1, 'closed later', true);
    expect(v.committed).toBe('');
    expect(v.pending).toBe('still open closed later');
  });

  it('joinerBetween matches the phone table', () => {
    expect(joinerBetween('句号。', '下一句')).toBe('\n');
    expect(joinerBetween('逗号，', '下一句')).toBe('');
    expect(joinerBetween('中文', '继续')).toBe('');
    expect(joinerBetween('word', 'next')).toBe(' ');
    expect(joinerBetween('word', ' next')).toBe('');
    expect(joinerBetween('', 'next')).toBe('');
  });
});
