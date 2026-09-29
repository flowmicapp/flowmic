import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refineFinalText } from '../src/stt/stt-refine-llm';
import { kickRefine } from '../src/engine/stt-session-refine';
import { runDetachedPolish } from '../src/engine/stt-session-detached-polish';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { log } from '../src/log';

const cfg = { protocol: 'openai-compatible' as const, endpoint: 'http://synthetic.invalid', model: 'synthetic', api_key: 'unused' };
const cases = [
  { raw: '请检查青琥珀项目的状态', polished: '请检查项目的状态', word: '青琥珀', family: 'dict', protectedTerms: ['青琥珀'] },
  { raw: '我从来没有去过那里', polished: '我从来去过那里', word: '没', family: 'closed_class', protectedTerms: [] },
];
beforeEach(() => {
  __resetPolishCacheForTest();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
});
afterEach(async () => { await new Promise<void>(resolve => setImmediate(resolve)); vi.restoreAllMocks(); });

it.each(cases)('refine $family emits categories and never the rejected word', async p => {
  const deps = { language: 'zh', protectedTerms: p.protectedTerms, streamerFor: () => async function* () { yield { kind: 'done' as const, full: p.polished }; } };
  const result = await refineFinalText(p.raw, cfg, deps);
  expect(result.text).toBeNull();
  expect(result.reason).toContain(p.word); // Internal decision remains exact; logger must sanitize it.
  const emit = vi.fn();
  await kickRefine({
    refine: { cfg: { enabled: true, min_utterance_ms: 15000 }, llm: { source: 'user', cfg }, deps },
    emitter: { emit }, utteranceId: 'synthetic-private-id', emitterClosed: () => false, meter: () => {},
  }, p.raw, 20000);
  expect(emit).not.toHaveBeenCalled();
  const warnings = vi.mocked(log.warn).mock.calls.filter(([name]) => name.startsWith('stt.refine'));
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings.every(([, fields]) => fields?.family === p.family)).toBe(true);
  expect(vi.mocked(log.info).mock.calls.find(([name]) => name.startsWith('stt.refine produced'))?.[1]?.family).toBe(p.family);
  const all = JSON.stringify([vi.mocked(log.warn).mock.calls, vi.mocked(log.info).mock.calls, vi.mocked(log.error).mock.calls]);
  expect(all).not.toContain(p.word);
  expect(all).not.toContain(p.raw);
  expect(all).not.toContain('synthetic-private-id');
});

it('the detached polish refusal also sanitizes its internal reason', async () => {
  await runDetachedPolish({ llm: { source: 'user', cfg }, deps: { language: 'zh', streamerFor: () => async function* () { yield { kind: 'done', full: '我去那里' }; } } }, '我没去那里', Date.now, () => {});
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(vi.mocked(log.warn).mock.calls.find(([name]) => name.includes('bare final stands'))?.[1]?.family).toBe('closed_class');
  expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('没');
});
