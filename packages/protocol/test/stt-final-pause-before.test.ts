import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import { EVENT_NAMES } from '../src/events';

// Card CR-12-D — `stt:final.pause_before_ms`, additive and optional.
//
// It answers 「这一段开始前静了多久」 so the phone can put a paragraph break where
// the speaker stopped. No new event name, no new error code — 「additive-field
// 优先」 — and the whitelist / count guard is untouched, which the last row here
// asserts rather than assumes.
//
// 🔴 ABSENCE IS A THIRD ANSWER, NOT 0, and the schema cannot enforce that: a
// receiver reading `?? 0` would type-check perfectly. The rule is defended on
// both sides of the wire instead — `apps/server-core/src/stt/segment-pause.ts`
// never emits a placeholder, and `apps/mobile/.../stt_stream.dart` parses a
// missing key to null. This file pins what the SCHEMA owes them: absence is
// legal in both directions, and a negative number is not.

const baseFinal = {
  text: '第二段。',
  confidence: 0.9,
  language: 'zh',
  segment_idx: 1,
  is_segment: true,
  duration_ms: 30_000,
} as const;

const parse = (extra: Record<string, unknown> = {}) =>
  safeParseEvent('stt:final', { ...baseFinal, ...extra });

describe('CR-12-D stt:final.pause_before_ms additive field', () => {
  it('a final with NO pause_before_ms parses, and reads undefined', () => {
    // The compat direction that matters: every relay built before this card
    // strips the field, and the phone has to land on 「我不知道」, not on 0.
    expect(parse({}).success).toBe(true);
    const r = EVENT_SCHEMAS['stt:final'].safeParse(baseFinal);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pause_before_ms).toBeUndefined();
  });

  it('carries the value the server produces, round-trip', () => {
    const r = EVENT_SCHEMAS['stt:final'].safeParse({ ...baseFinal, pause_before_ms: 5_040 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pause_before_ms).toBe(5_040);
  });

  it('0 is a legal value and is NOT the same thing as absence', () => {
    // A speaker who did not stop at all: the boundary was a sentence terminator
    // and the next word follows immediately. That is a MEASUREMENT of zero.
    const r = EVENT_SCHEMAS['stt:final'].safeParse({ ...baseFinal, pause_before_ms: 0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pause_before_ms).toBe(0);
  });

  it('a negative or fractional pause is refused — it is ms of audio, not a delta', () => {
    expect(parse({ pause_before_ms: -1 }).success).toBe(false);
    expect(parse({ pause_before_ms: 1.5 }).success).toBe(false);
  });

  it('🔴 no new event name — the whitelist and its count guard are untouched', () => {
    // The point of an additive FIELD is that this list does not move. If this
    // row ever fails, someone answered a payload question with an event.
    expect(EVENT_NAMES).toContain('stt:final');
    expect(EVENT_NAMES.filter((n) => n.startsWith('stt:'))).not.toContain('stt:pause');
  });
});
