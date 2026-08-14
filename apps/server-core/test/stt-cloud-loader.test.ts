// H6/P2 registration seam — the optional dynamic load of the PRIVATE
// `@flowmic/stt-cloud` package (card §158-171 + B15 ruling (a)).
//
// 🔴 Why this file exists at all: an optional dynamic load is the one mechanism
// that fails SILENTLY by construction. Card §207: "a dynamic optional load is silent no-op by nature,
// and that is exactly this repo's #1 bug shape". So both directions are pinned here:
//   - ABSENT  ⇒ throws, BY NAME, and never falls back to another vendor;
//   - PRESENT ⇒ actually constructs, and is handed server-core's OWN error
//     classes (identity, not shape).
// The fail-loud paradigm is copied from `managed-default.ts`
// (ENABLED-but-invalid throws instead of skipping).

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEngineFactory, requireCloudEngine, isStreamingEngine, STREAMING_ENGINES } from '../src/stt/engine-factory';
import { SttEngineError, unexpectedCloseError, type SttEngineConfig } from '../src/stt/engines/base';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-stt-cloud.cjs');
const CFG: SttEngineConfig = { id: 'soniox', language: 'zh', sample_rate: 16_000, api_key: 'k' };

const ENV_KEY = 'FLOWMIC_STT_CLOUD_MODULE';
afterEach(() => { delete process.env[ENV_KEY]; });

describe('cloud engine registration seam', () => {
  it('the union member exists and the switch has a case (B15 option (a))', () => {
    // If `soniox` were missing from SttEngineId, this file would not compile —
    // that is the `_exhaustive: never` asset the card refused to trade away.
    const ids: SttEngineConfig['id'][] = ['soniox'];
    expect(ids).toEqual(['soniox']);
  });

  it('🔴 FAIL-LOUD: an absent private package throws BY NAME — never a silent fallback', () => {
    process.env[ENV_KEY] = '@flowmic/definitely-not-installed-xyz';
    let thrown: unknown;
    try { defaultEngineFactory('soniox', CFG); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // Names the ENGINE and the MODULE — a bare 'Cannot find module' would leave
    // the operator guessing which of many optional deps is missing.
    expect(msg).toContain('soniox');
    expect(msg).toContain('@flowmic/definitely-not-installed-xyz');
    // And says WHY it is expected in a self-hosted build (H1/H3), so nobody
    // "fixes" it by wiring a fallback engine.
    expect(msg).toMatch(/self-hosted|open-source/i);
  });

  it('does NOT substitute another engine when the cloud package is missing', () => {
    process.env[ENV_KEY] = '@flowmic/definitely-not-installed-xyz';
    // The negative assertion that matters: no object comes back at all.
    // A silent fallback would return a working engine of a DIFFERENT vendor and
    // the user would be transcribed by someone nobody chose (A6 §3-3 red line).
    expect(() => defaultEngineFactory('soniox', CFG)).toThrow();
  });

  it('a module that resolves but lacks createEngine also throws by name', () => {
    process.env[ENV_KEY] = 'node:path'; // resolves fine, wrong shape
    expect(() => defaultEngineFactory('soniox', CFG)).toThrow(/no createEngine|exports no createEngine/i);
  });

  it('PRESENT: the loader really constructs through the package (success path proven)', () => {
    process.env[ENV_KEY] = FIXTURE;
    const engine = defaultEngineFactory('soniox', CFG) as unknown as { id: string; __host: { SttEngineError: unknown; unexpectedCloseError: unknown } };
    expect(engine.id).toBe('soniox');
    // 🔴 Class IDENTITY, not shape: server-core does `err instanceof
    // SttEngineError` (http/probe-routes.ts:457). If the adapter built its own
    // class, that check would answer false and a specific auth failure would
    // silently degrade to a generic probe failure.
    expect(engine.__host.SttEngineError).toBe(SttEngineError);
    expect(engine.__host.unexpectedCloseError).toBe(unexpectedCloseError);
  });

  it('requireCloudEngine is reachable directly (the switch is not the only door)', () => {
    process.env[ENV_KEY] = FIXTURE;
    expect(requireCloudEngine('soniox', CFG).id).toBe('soniox');
  });
});

describe('card §4a — STREAMING_ENGINES drives three things and none of them compile-fails', () => {
  it('soniox is a streaming engine (membership)', () => {
    expect(STREAMING_ENGINES.has('soniox')).toBe(true);
    expect(isStreamingEngine('soniox')).toBe(true);
  });

  it('the batch engines stay out (a set that says yes to everything proves nothing)', () => {
    for (const id of ['openai-whisper', 'custom-openai-compatible', 'funspeech-http', 'sherpa-local'] as const) {
      expect(isStreamingEngine(id)).toBe(false);
    }
  });
});
