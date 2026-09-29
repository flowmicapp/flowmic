// Run the existing files unchanged, recording every live vector they actually use.
import { afterAll, expect, vi } from 'vitest';
import type { GuardOpts, GuardResult } from '../src/stt/stt-polish-guard';
const recorder = vi.hoisted(() => ({ active: true, pairs: [] as { raw: string; polished: string; opts: GuardOpts; result: GuardResult }[] }));
vi.mock('../src/stt/stt-polish-guard', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/stt/stt-polish-guard')>();
  return { ...actual, checkMeaningPreserved: (raw: string, polished: string, opts: GuardOpts = {}) => {
    const result = actual.checkMeaningPreserved(raw, polished, opts);
    if (recorder.active) recorder.pairs.push({ raw, polished, opts, result });
    return result;
  } };
});
import './stt-polish-guard-langs.test';
import './stt-polish-guard-coverage.test';
import './stt-polish-guard-strip-boundary.test';
import './polish-guard-declared-terms.test';
import { checkMeaningPreservedV2 } from '../src/stt/stt-polish-guard-v2';
afterAll(() => {
  recorder.active = false;
  expect(recorder.pairs.length).toBeGreaterThan(20);
  for (const pair of recorder.pairs) {
    const shadow = checkMeaningPreservedV2(pair.raw, pair.polished, { ...pair.opts, language: 'zh' });
    if (pair.result.ok) expect(shadow.ok).toBe(true);
  }
});
