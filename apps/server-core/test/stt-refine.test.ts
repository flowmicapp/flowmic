// GA-14 — two-pass refine, decision core.
//
// Every test here is about NOT MAKING THINGS WORSE. The utterance already
// succeeded, was already delivered, and is already on the user's screen; refine
// is only allowed to improve on that or stay silent.
//
// SPEC-REF: docs/rebuild/06-STT-ENGINE-LAYER.md §5;
//           docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-14

import { describe, it, expect } from 'vitest';
import { STT_REFINE_MIN_UTTERANCE_MS } from '@flowmic/protocol';
import {
  RetainedAudio,
  isSameTranscript,
  refineFloorMs,
  refinedTextOrNull,
  runRefine,
  shouldRefine,
} from '../src/stt/stt-refine';

describe('shouldRefine', () => {
  it('never runs when the switch is off or absent', () => {
    expect(shouldRefine(null, 60_000)).toBe(false);
    expect(shouldRefine({ enabled: false }, 60_000)).toBe(false);
  });

  it('never runs below the floor — a second pass is a second bill', () => {
    const cfg = { enabled: true };
    expect(refineFloorMs(cfg)).toBe(STT_REFINE_MIN_UTTERANCE_MS);
    expect(shouldRefine(cfg, STT_REFINE_MIN_UTTERANCE_MS - 1)).toBe(false);
    expect(shouldRefine(cfg, STT_REFINE_MIN_UTTERANCE_MS)).toBe(true);
  });

  it('honours an explicit floor', () => {
    expect(shouldRefine({ enabled: true, min_utterance_ms: 3_000 }, 4_000)).toBe(true);
    expect(shouldRefine({ enabled: true, min_utterance_ms: 30_000 }, 20_000)).toBe(false);
  });

  it('refuses a nonsense duration instead of treating it as long', () => {
    for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shouldRefine({ enabled: true, min_utterance_ms: 1_000 }, d), String(d)).toBe(false);
    }
  });
});

describe('refinedTextOrNull', () => {
  it('an empty second pass is a FAILED pass, never a better transcript', () => {
    // Emitting this would blank a row the user could read a second ago.
    expect(refinedTextOrNull('今天天气不错', '')).toBeNull();
    expect(refinedTextOrNull('今天天气不错', '   \n ')).toBeNull();
  });

  it('identical text produces NOTHING — a no-op signal teaches users to ignore signals', () => {
    expect(refinedTextOrNull('hello world', 'hello world')).toBeNull();
    // Whitespace/format-only differences are not news either.
    expect(refinedTextOrNull('hello world', ' hello  world ')).toBeNull();
    expect(isSameTranscript('你好 世界', '你好世界')).toBe(true);
  });

  it('a genuinely different transcript comes back trimmed', () => {
    expect(refinedTextOrNull('鹅鹅鹅', '  额额额  ')).toBe('额额额');
  });
});

describe('runRefine', () => {
  const pcm = Buffer.alloc(16_000 * 2); // 1 s of silence — content is irrelevant here

  it('returns the better text', async () => {
    const out = await runRefine({
      pcm,
      firstPass: 'first',
      transcribe: async () => 'second',
    });
    expect(out).toBe('second');
  });

  it('an engine failure is REPORTED to the caller and produces no text', async () => {
    // The split this exists for: loud in the log, quiet on the wire. The user's
    // utterance already succeeded — an error banner would report a failure that
    // did not happen to anything they asked for.
    let seen: unknown = null;
    const out = await runRefine({
      pcm,
      firstPass: 'first',
      transcribe: async () => {
        throw new Error('engine down');
      },
      onError: (e) => {
        seen = e;
      },
    });
    expect(out).toBeNull();
    expect((seen as Error).message).toBe('engine down');
  });

  it('no audio ⇒ no engine call at all', async () => {
    let called = false;
    const out = await runRefine({
      pcm: Buffer.alloc(0),
      firstPass: 'first',
      transcribe: async () => {
        called = true;
        return 'second';
      },
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });
});

describe('RetainedAudio', () => {
  it('returns the utterance in order', () => {
    const r = new RetainedAudio(1_000);
    r.push(Buffer.from([1, 2]));
    r.push(Buffer.from([3, 4]));
    expect([...r.take()]).toEqual([1, 2, 3, 4]);
    expect(r.byteLength).toBe(4);
  });

  it('an overflow refines NOTHING rather than a partial span', () => {
    // The failure this prevents: silently transcribing the last N seconds of a
    // long utterance and presenting it as a better version of the whole thing.
    const r = new RetainedAudio(4);
    r.push(Buffer.from([1, 2, 3]));
    r.push(Buffer.from([4, 5, 6]));
    expect(r.overflowed).toBe(true);
    expect(r.take().length).toBe(0);
    expect(r.byteLength).toBe(0);
    // …and it stays refused: a later small chunk must not resurrect a truncated
    // buffer into something that looks whole.
    r.push(Buffer.from([7]));
    expect(r.take().length).toBe(0);
  });

  it('clear() makes it reusable for the next utterance', () => {
    const r = new RetainedAudio(4);
    r.push(Buffer.from([1, 2, 3, 4, 5]));
    expect(r.overflowed).toBe(true);
    r.clear();
    r.push(Buffer.from([9]));
    expect([...r.take()]).toEqual([9]);
  });

  it('the default cap covers a full 5-minute recording', () => {
    // The hard recording limit is 5 min; a cap below it would make refine
    // useless for exactly the long utterances it exists to help.
    const fiveMinBytes = 5 * 60 * 16_000 * 2;
    const r = new RetainedAudio();
    r.push(Buffer.alloc(fiveMinBytes));
    expect(r.overflowed).toBe(false);
    expect(r.byteLength).toBe(fiveMinBytes);
  });
});
