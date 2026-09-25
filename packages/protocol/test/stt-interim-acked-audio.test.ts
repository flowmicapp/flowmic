import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import { EVENT_NAMES } from '../src/events';

// Card RC-2 — `stt:interim.acked_audio_ms`, additive and optional.
//
// It lets a recovery feed on the phone bound the audio it has in flight by the
// engine's own processed position instead of racing the whole recording into a
// real-time engine (CR-12-E, root-cause doc §1.5/§1.6). No new event name and no
// new error code; the last row asserts that rather than assuming it.
//
// Absence is its own answer (the engine reports nothing, or the relay predates
// the card) and the phone reads it as null, never as 0: a 0 would read as
// 「the vendor has processed nothing」 and stall the feed on every old relay.

const base = { text: '今天上午', confidence: 0.8, language: 'zh', segment_idx: 0 } as const;
const parse = (extra: Record<string, unknown> = {}) =>
  safeParseEvent('stt:interim', { ...base, ...extra });

describe('RC-2 stt:interim.acked_audio_ms additive field', () => {
  it('an interim with NO acked_audio_ms parses and reads undefined', () => {
    expect(parse({}).success).toBe(true);
    const r = EVENT_SCHEMAS['stt:interim'].safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.acked_audio_ms).toBeUndefined();
  });

  it('carries the value the relay produces through the registry, round-trip', () => {
    const r = EVENT_SCHEMAS['stt:interim'].safeParse({ ...base, acked_audio_ms: 41_240 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.acked_audio_ms).toBe(41_240);
  });

  it('0 is legal and distinct from absence', () => {
    const r = EVENT_SCHEMAS['stt:interim'].safeParse({ ...base, acked_audio_ms: 0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.acked_audio_ms).toBe(0);
  });

  it('a negative or fractional position is refused', () => {
    expect(parse({ acked_audio_ms: -1 }).success).toBe(false);
    expect(parse({ acked_audio_ms: 2.5 }).success).toBe(false);
  });

  it('no new event name: the whitelist does not move for a payload field', () => {
    expect(EVENT_NAMES).toContain('stt:interim');
    expect(EVENT_NAMES.filter((n) => n.startsWith('stt:'))).not.toContain('stt:ack');
  });
});
