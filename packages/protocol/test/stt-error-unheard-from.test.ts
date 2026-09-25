import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import { EVENT_NAMES } from '../src/events';

// Card RC4-S5 — `stt:error.unheard_from_ms`, additive and optional.
//
// When the relay ends a recording with voice no engine leg heard
// (STT_SEGMENT_NOT_TRANSCRIBED), it says where that stretch begins, on the
// sender's own audio clock, so the phone can owe exactly that stretch and not
// re-transcribe words the terminal final already carries (CR-12-E re-run 4, S5).
// No new event name and no new error code; the last row asserts that.
//
// Absence is its own answer (an older relay, or a ring that no longer holds the
// chunk) and the phone reads it as null, never as 0: a 0 would owe the whole
// recording from its first sample.

const base = { code: 'STT_SEGMENT_NOT_TRANSCRIBED', message: 'no engine leg was open to take it', retryable: false } as const;
const parse = (extra: Record<string, unknown> = {}) => safeParseEvent('stt:error', { ...base, ...extra });

describe('RC4-S5 stt:error.unheard_from_ms additive field', () => {
  it('an error with NO unheard_from_ms parses and reads undefined (every relay before the card)', () => {
    expect(parse({}).success).toBe(true);
    const r = EVENT_SCHEMAS['stt:error'].safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unheard_from_ms).toBeUndefined();
  });

  it('carries the value the relay produces through the registry, round-trip', () => {
    const r = EVENT_SCHEMAS['stt:error'].safeParse({ ...base, unheard_from_ms: 1_790_264_053_153 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unheard_from_ms).toBe(1_790_264_053_153);
  });

  it('0 is legal and distinct from absence', () => {
    const r = EVENT_SCHEMAS['stt:error'].safeParse({ ...base, unheard_from_ms: 0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unheard_from_ms).toBe(0);
  });

  it('a negative or fractional position is refused', () => {
    expect(parse({ unheard_from_ms: -1 }).success).toBe(false);
    expect(parse({ unheard_from_ms: 2.5 }).success).toBe(false);
  });

  it('no new event name: the whitelist does not move for a payload field', () => {
    expect(EVENT_NAMES).toContain('stt:error');
    expect(EVENT_NAMES).toHaveLength(57);
  });
});
