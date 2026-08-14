// WP-R1-3 routing contract tests (06 §4 no implicit fallback #16). Covers pickEngine's
// explicit→wildcard→managed→throw order, per-call re-resolution, the BYOK
// judgement (06 §4), the env-gated managed default (fail-loud on bad engine),
// and the id→constructor switch (all seven engines incl. sherpa-local).

import { describe, expect, it } from 'vitest';
import {
  makeEngineRouter, selectRouting, selectRoutingWithSource, SttConfigMissingError,
  type Routing, type EngineFactory, type SelectedRouting,
} from '../src/stt/engine-router';
import { managedDefaultRouting } from '../src/stt/managed-default';
import { defaultEngineFactory, resolveByok } from '../src/stt/engine-factory';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';

/** A trivial engine stub the router builds without touching the network. */
class StubEngine implements SttEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}
const stubFactory: EngineFactory = (id, cfg) => new StubEngine(id, cfg) as unknown as SttEngine;

const R = (over: Partial<Routing>): Routing => ({ language: 'zh', engine_id: 'funasr', ...over });

describe('pickEngine — no implicit fallback (#16)', () => {
  it('resolves an exact language match', () => {
    const router = makeEngineRouter();
    const e = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'funasr', endpoint: 'ws://x' })], stubFactory) as unknown as StubEngine;
    expect(e.id).toBe('funasr');
    expect(e.cfg.endpoint).toBe('ws://x');
    expect(e.cfg.sample_rate).toBe(16_000);
  });

  it('falls to the universal * routing when no exact match', () => {
    const router = makeEngineRouter();
    const e = router.pickEngine('ja', [R({ language: '*', engine_id: 'custom-openai-compatible' })], stubFactory) as unknown as StubEngine;
    expect(e.id).toBe('custom-openai-compatible');
    expect(e.cfg.language).toBe('ja'); // requested language stamped, not '*'
  });

  it('THROWS SttConfigMissingError when nothing matches (never a silent default)', () => {
    const router = makeEngineRouter();
    expect(() => router.pickEngine('ko', [R({ language: 'zh' })], stubFactory)).toThrow(SttConfigMissingError);
  });

  it('consults the managed default only after user routings miss', () => {
    const managed: Routing = { language: '*', engine_id: 'deepgram', api_key: 'mk' };
    const router = makeEngineRouter({ managedDefault: () => managed });
    // user routing wins
    const a = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'funasr' })], stubFactory) as unknown as StubEngine;
    expect(a.id).toBe('funasr');
    // miss → managed default
    const b = router.pickEngine('ko', [], stubFactory) as unknown as StubEngine;
    expect(b.id).toBe('deepgram');
  });

  it('re-resolves per call (a settings change takes effect next audio:start)', () => {
    const router = makeEngineRouter();
    const first = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'funasr' })], stubFactory) as unknown as StubEngine;
    const second = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'openai-whisper' })], stubFactory) as unknown as StubEngine;
    expect(first.id).toBe('funasr');
    expect(second.id).toBe('openai-whisper');
  });
});

describe('selectRouting + resolveByok (06 §4)', () => {
  const user = (routing: Routing): SelectedRouting => ({ routing, source: 'user' });

  it('BYOK = user-supplied non-empty api_key; EMPTY sentinel + blank = platform', () => {
    expect(resolveByok(user({ language: '*', engine_id: 'deepgram', api_key: 'user-key' }))).toBe(true);
    expect(resolveByok(user({ language: '*', engine_id: 'custom-openai-compatible', api_key: '' }))).toBe(false);
    expect(resolveByok(user({ language: '*', engine_id: 'openai-whisper', api_key: 'EMPTY' }))).toBe(false);
    expect(resolveByok(user({ language: 'zh', engine_id: 'funasr' }))).toBe(false); // no key at all
    expect(resolveByok(null)).toBe(false);
  });

  // 🔴 T7 ①: the SAME key string, differing only in who supplied it.
  it('T7 ①: an identical key is BYOK from the user and NOT BYOK from the platform', () => {
    const routing: Routing = { language: '*', engine_id: 'deepgram', api_key: 'the-very-same-key' };
    expect(resolveByok({ routing, source: 'user' })).toBe(true);
    expect(resolveByok({ routing, source: 'managed-default' })).toBe(false);
  });

  it('T7 ①: selectRoutingWithSource stamps the provenance the resolver needs', () => {
    const managed = (): Routing => ({ language: '*', engine_id: 'deepgram', api_key: 'platform-key' });
    // user routing wins → source user → its key IS byok
    const a = selectRoutingWithSource('zh', [R({ language: 'zh', engine_id: 'deepgram', api_key: 'mine' })], managed);
    expect(a).toMatchObject({ source: 'user' });
    expect(resolveByok(a)).toBe(true);
    // user routings miss → managed default → source managed-default → NOT byok
    const b = selectRoutingWithSource('ko', [], managed);
    expect(b).toMatchObject({ source: 'managed-default' });
    expect(b?.routing.api_key).toBe('platform-key'); // the key really is non-empty
    expect(resolveByok(b)).toBe(false);
  });

  it('selectRouting mirrors pickEngine selection order', () => {
    const routings = [R({ language: 'zh', engine_id: 'funasr' }), R({ language: '*', engine_id: 'custom-openai-compatible' })];
    expect(selectRouting('zh', routings)?.engine_id).toBe('funasr');
    expect(selectRouting('en', routings)?.engine_id).toBe('custom-openai-compatible');
    expect(selectRouting('en', [])).toBeNull();
  });
});

describe('managedDefaultRouting — env gate (fail-loud)', () => {
  it('returns null when disabled', () => {
    expect(managedDefaultRouting({} as NodeJS.ProcessEnv)).toBeNull();
    expect(managedDefaultRouting({ FLOWMIC_MANAGED_STT_ENABLED: '0' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('builds a * routing when enabled with a valid engine', () => {
    const r = managedDefaultRouting({
      FLOWMIC_MANAGED_STT_ENABLED: '1',
      FLOWMIC_MANAGED_STT_ENGINE: 'deepgram',
      FLOWMIC_MANAGED_STT_ENDPOINT: 'wss://x',
      FLOWMIC_MANAGED_STT_API_KEY: 'k',
    } as unknown as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ language: '*', engine_id: 'deepgram', endpoint: 'wss://x', api_key: 'k' });
  });

  it('THROWS (fail-loud) when enabled with an invalid engine id', () => {
    expect(() => managedDefaultRouting({
      FLOWMIC_MANAGED_STT_ENABLED: 'true', FLOWMIC_MANAGED_STT_ENGINE: 'not-an-engine',
    } as unknown as NodeJS.ProcessEnv)).toThrow(/invalid/i);
  });
});

describe('defaultEngineFactory — id → constructor switch (all 7)', () => {
  const ids: SttEngineId[] = [
    'funasr', 'deepgram', 'openai-realtime', 'openai-whisper',
    'custom-openai-compatible', 'funspeech-http', 'sherpa-local',
  ];
  it('constructs a real engine for every catalogue id', () => {
    for (const id of ids) {
      const e = defaultEngineFactory(id, { id, language: 'zh', sample_rate: 16_000 });
      expect(e.id).toBe(id);
    }
  });
});
