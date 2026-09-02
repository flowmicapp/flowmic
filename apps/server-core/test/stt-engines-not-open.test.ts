// Card B2-G (2026-09-02) — one shared test for a finding left by WP-1: every
// bundled STT engine adapter's `push()` guard for "called while not `'open'`"
// threw `STT_ENGINE_TIMEOUT`. That was never true — none of these calls ever
// reach a vendor, so nothing can time out waiting for a reply. It is a
// caller/orchestrator invariant violation: audio arrived for an engine session
// that had not opened yet, had already closed, or had already failed.
//
// `STT_ENGINE_NOT_OPEN` (packages/protocol/src/error-codes.ts) is the honest
// replacement, and this file is the "one shared test" the finding asked for:
// a single parametrised table over all seven of the adapters that live in
// this package, rather than seven copy-pasted assertions that could drift
// independently. The eighth adapter, `SonioxEngine`, lives in the separate
// `@flowmic/stt-cloud` package and CANNOT be imported here — `engine-factory.ts`
// loads it through a variable-specifier `require` specifically so bundlers
// (and, by the same property, this open-source package's own test graph)
// never pull it in (see that file's `cloudSpecifier()` doc block and
// `packages/stt-cloud/src/index.ts`'s "NEVER... SHIPPED TO A SELF-HOSTED
// USER" header). Soniox's half of this same assertion lives in
// `packages/stt-cloud/test/soniox.test.ts` ("push before open is a retryable
// STT_ENGINE_NOT_OPEN...").
//
// Reverse control: with the fix reverted (the eight throw sites back to
// `STT_ENGINE_TIMEOUT`), every row in the table below fails on the `.code`
// assertion — seen red during this change, restored, seen green again.

import { describe, expect, it } from 'vitest';
import { CustomOpenAiCompatibleEngine } from '../src/stt/engines/custom-openai-compatible';
import { DeepgramEngine } from '../src/stt/engines/deepgram';
import { FunasrEngine } from '../src/stt/engines/funasr';
import { FunspeechHttpEngine } from '../src/stt/engines/funspeech-http';
import { OpenAiRealtimeEngine } from '../src/stt/engines/openai-realtime';
import { OpenAiWhisperEngine } from '../src/stt/engines/openai-whisper';
import { SherpaLocalEngine } from '../src/stt/engines/sherpa-local';
import { SttEngineError, type SttEngine, type SttEngineConfig } from '../src/stt/engines/base';

const cfg = (id: SttEngineConfig['id']): SttEngineConfig => ({
  id, language: 'en', sample_rate: 16_000,
});

/** Every entry constructs a fresh, never-opened instance with only its
 *  required `SttEngineConfig` (every adapter's `deps` param defaults to `{}`,
 *  so none of this needs a fake socket or fetch). `_state` starts `'closed'`
 *  on all seven (grepped: `private _state: EngineState = 'closed'`), so the
 *  `push()` guard fires on the very first call, before any transport code
 *  runs. */
const ENGINES: ReadonlyArray<[name: string, make: () => SttEngine]> = [
  ['CustomOpenAiCompatibleEngine', () => new CustomOpenAiCompatibleEngine(cfg('custom-openai-compatible'))],
  ['DeepgramEngine', () => new DeepgramEngine(cfg('deepgram'))],
  ['FunasrEngine', () => new FunasrEngine(cfg('funasr'))],
  ['FunspeechHttpEngine', () => new FunspeechHttpEngine(cfg('funspeech-http'))],
  ['OpenAiRealtimeEngine', () => new OpenAiRealtimeEngine(cfg('openai-realtime'))],
  ['OpenAiWhisperEngine', () => new OpenAiWhisperEngine(cfg('openai-whisper'))],
  ['SherpaLocalEngine', () => new SherpaLocalEngine(cfg('sherpa-local'))],
];

describe('every bundled STT adapter: push() while not open is STT_ENGINE_NOT_OPEN, never a false timeout', () => {
  it.each(ENGINES)('%s', (_name, make) => {
    const engine = make();
    expect(engine.state).toBe('closed');
    let caught: unknown;
    try {
      engine.push(Buffer.alloc(4), 0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SttEngineError);
    const err = caught as SttEngineError;
    // The honest code — this is the assertion the old `STT_ENGINE_TIMEOUT`
    // would fail (nothing was sent to a vendor, so nothing timed out).
    expect(err.code).toBe('STT_ENGINE_NOT_OPEN');
    expect(err.message).toMatch(/not open/);
    // Unchanged from what every site already declared: the condition is
    // usually transient (a chunk arriving mid-rollover/mid-reconnect), and
    // the reconnect ladder — not this code — decides what to do about it.
    expect(err.retryable).toBe(true);
  });

  it('positive control: the table is not vacuous (all seven adapters ran)', () => {
    expect(ENGINES).toHaveLength(7);
  });
});
