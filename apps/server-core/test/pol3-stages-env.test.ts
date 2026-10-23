// Card POL-3 — T13: FLOWMIC_POLISH_STAGES is parsed once at boot, fails loud on any
// other value, refuses `context+kick` until card POL-5 implements it, and refuses
// to run together with FLOWMIC_POLISH_SPECULATIVE=on (design §3.1, §8; book 06 §5
// POL-0 block, 「开关」).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { bootPolishStages, readPolishStagesFromEnv } from '../src/engine/polish-stages-env';

describe('card POL-3 — T13 the stages switch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('unset, empty and legacy all read as legacy; context reads as context', () => {
    expect(readPolishStagesFromEnv({})).toBe('legacy');
    expect(readPolishStagesFromEnv({ FLOWMIC_POLISH_STAGES: '' })).toBe('legacy');
    expect(readPolishStagesFromEnv({ FLOWMIC_POLISH_STAGES: 'legacy' })).toBe('legacy');
    expect(readPolishStagesFromEnv({ FLOWMIC_POLISH_STAGES: 'context' })).toBe('context');
  });

  it('🔴 any other value fails the boot, naming the variable (typos, case, whitespace)', () => {
    for (const bad of ['Context', 'context ', 'on', 'true', 'kick', 'context,kick']) {
      expect(() => readPolishStagesFromEnv({ FLOWMIC_POLISH_STAGES: bad }), bad).toThrow(/FLOWMIC_POLISH_STAGES/);
    }
  });

  it('🔴 context+kick fails the boot until card POL-5 lands (never silently downgraded to context)', () => {
    expect(() => readPolishStagesFromEnv({ FLOWMIC_POLISH_STAGES: 'context+kick' })).toThrow(/POL-5/);
  });

  it('🔴 context together with FLOWMIC_POLISH_SPECULATIVE=on fails the boot (reverse: drop the pair check)', () => {
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    expect(() => bootPolishStages(true, { FLOWMIC_POLISH_STAGES: 'context' })).toThrow(/mutually exclusive/);
    expect(bootPolishStages(true, {})).toBe('legacy'); // legacy + speculation stays allowed
    expect(bootPolishStages(false, { FLOWMIC_POLISH_STAGES: 'context' })).toBe('context');
  });

  it('the boot logs the value it runs with', () => {
    const seen: [string, Record<string, unknown>][] = [];
    vi.spyOn(log, 'info').mockImplementation((m: string, f?: Record<string, unknown>) => { seen.push([m, f ?? {}]); });
    bootPolishStages(false, { FLOWMIC_POLISH_STAGES: 'context' });
    expect(seen).toContainEqual(['stt.polish stages switch', { FLOWMIC_POLISH_STAGES: 'context' }]);
  });
});
