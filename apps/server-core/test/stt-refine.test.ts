// The second pass — decision core (no engine, no LLM, no socket).
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
  isSameTranscript,
  refineFloorMs,
  refinedTextOrNull,
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
