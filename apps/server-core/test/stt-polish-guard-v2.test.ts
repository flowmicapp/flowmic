import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from '@flowmic/protocol';
import * as terms from '../src/stt/stt-polish-guard-terms';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PolishStrength, LlmConfig } from '@flowmic/protocol';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import { buildStutterTerms, checkMeaningPreservedV2, STUTTER_TERMS } from '../src/stt/stt-polish-guard-v2';
import { polishFinalText, __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { log } from '../src/log';

interface Pair { id: string; lang: string; strength: PolishStrength; raw: string; polished: string; v1: boolean; v2: boolean; family: string; why: string }
const pairs: Pair[] = readFileSync(new URL('./fixtures/polish-guard-v2-pairs.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Pair);
const baseSource = readFileSync(new URL('./fixtures/polish-guard-v1-base.txt', import.meta.url), 'utf8');
const baseline: { checkMeaningPreserved?: typeof checkMeaningPreserved } = {};
runInNewContext(ts.transpileModule(baseSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: baseline, require: (name: string) => { if (name === '@flowmic/protocol') return protocol; if (name === './stt-polish-guard-terms') return terms; throw new Error('unexpected baseline import'); },
});
afterAll(() => {
  console.log('NR118 corpus:', JSON.stringify({ n: pairs.length, live_accept: pairs.filter(p => p.v1).length, live_reject: pairs.filter(p => !p.v1).length, shadow_accept: pairs.filter(p => p.v2).length, shadow_reject: pairs.filter(p => !p.v2).length, newly_accepted: pairs.filter(p => !p.v1 && p.v2).length, live_changes: 0 }));
});
describe('NR118 synthetic corpus: shadow rules and unchanged live delivery', () => {
  it('has at least sixty synthetic pairs and pins the live function to the branch base', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(60);
    // Frozen verbatim from 338ec85c; works in shallow clones without that git object.
    expect(createHash('sha256').update(baseSource.replace(/\r\n/g, '\n')).digest('hex')).toBe('16111baa2efcc1083e55dbf20ed564c84a5e311d8e2c8d4eef40c2f87a1003c6');
    const base = readFileSync(new URL('./fixtures/polish-guard-v1-base.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const live = readFileSync(new URL('../src/stt/stt-polish-guard.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(live.slice(live.indexOf('export function checkMeaningPreserved'))).toBe(base.slice(base.indexOf('export function checkMeaningPreserved')));
  });
  for (const p of pairs) it(`${p.id}: ${p.raw} → ${p.polished}`, async () => {
    const opts = { strength: p.strength, language: p.lang };
    const base = baseline.checkMeaningPreserved!(p.raw, p.polished, opts);
    expect(checkMeaningPreserved(p.raw, p.polished, opts)).toEqual(base);
    const shadow = checkMeaningPreservedV2(p.raw, p.polished, opts);
    expect(base.ok, 'frozen v1 corpus decision').toBe(p.v1);
    expect(shadow.ok, 'shadow decision').toBe(p.v2);
    if (base.ok) expect(shadow.ok, 'monotonicity').toBe(true);
    __resetPolishCacheForTest();
    const cfg: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://synthetic.invalid', model: 'synthetic', api_key: 'unused' };
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const live = await polishFinalText(p.raw, cfg, { ...opts, streamerFor: () => async function* () { yield { kind: 'done', full: p.polished }; } });
      expect(live.skipReason === 'guard_reject', 'production still decides with v1').toBe(!base.ok);
      expect(live.text).toBe(base.ok ? p.polished : p.raw);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(info.mock.calls.filter(([name]) => name === 'stt.polish.guard')).toHaveLength(1);
    } finally { info.mockRestore(); warn.mockRestore(); }
  });
  it('admits no golden_bad rejected by v1 at either strength', () => {
    const corpus = readFileSync(new URL('../../../verify/eval/cases/realtime.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { input: string; golden_bad: string; lang: string; id: string });
    let rejected = 0;
    for (const row of corpus) for (const strength of ['strict', 'smooth'] as const) {
      if (!checkMeaningPreserved(row.input, row.golden_bad, { strength }).ok) {
        rejected++;
        expect(checkMeaningPreservedV2(row.input, row.golden_bad, { strength, language: row.lang }).ok, row.id).toBe(false);
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it('filters negation terms out even when they are offered to stutter collapse', () => {
    const negation = terms.CLOSED_CLASS_CATEGORIES.negation;
    const built = buildStutterTerms([...STUTTER_TERMS, ...negation]);
    expect(negation.filter(term => built.includes(term))).toEqual([]);
  });

  it('checks exact negation counts before collapsing a repeated Japanese modal', () => {
    const result = checkMeaningPreservedV2(
      'なければならないなければならない',
      'なければならない',
      { strength: 'strict', language: 'ja' },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('closed-class-drift');
  });
});
