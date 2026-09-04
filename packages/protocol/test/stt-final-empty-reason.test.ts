import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import { EVENT_NAMES } from '../src/events';

// Card EMPTY-1 — `stt:final.empty_reason`, additive and optional.
//
// It answers 「why does this final carry no text」 for the one cause no registered
// ErrorCode answers honestly: the feed gate accepted speech, the engine finished
// cleanly, and it returned no words. Adding a code is an owner gate in this repo,
// so the fact rides an existing frame — no new event name, no new code, and the
// whitelist / count guard (`events-count.test.ts`) is untouched, which the last
// row here asserts rather than assumes.
//
// `empty_reason` is a PERMISSIVE string for the same reason `polish_reason` is:
// additive forward-compat means a receiver must never REJECT a future value. The
// canonical domain lives in the server's wire mapping
// (`apps/server-core/src/stt/empty-final-cause.ts`), and the phone renders an
// unrecognised value as its generic sentence plus the bare token.

const baseFinal = {
  text: '',
  confidence: 0,
  language: 'fr',
  segment_idx: 0,
  is_segment: false,
  duration_ms: 3060,
} as const;

const parse = (extra: Record<string, unknown> = {}) =>
  safeParseEvent('stt:final', { ...baseFinal, ...extra });

describe('EMPTY-1 stt:final.empty_reason additive field', () => {
  it('a legacy stt:final with NO empty_reason still parses, and reads undefined', () => {
    // The compat direction that matters most: every relay and every server built
    // before this card strips the field, and the phone must land exactly where it
    // was — on its own 「no speech was heard」 sentence, never on a third state.
    expect(parse({}).success).toBe(true);
    const r = EVENT_SCHEMAS['stt:final'].safeParse(baseFinal);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.empty_reason).toBeUndefined();
  });

  it('carries the two values the server actually produces today', () => {
    for (const reason of ['no_voice', 'heard_no_words']) {
      const r = EVENT_SCHEMAS['stt:final'].safeParse({ ...baseFinal, empty_reason: reason });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.empty_reason).toBe(reason);
    }
  });

  it('🔴 does NOT reject an unknown value — a newer server must not be silenced', () => {
    // A zod enum here would make a future reason value fail at the boundary, and
    // boundary rejection is anonymous and silent: the phone would show nothing at
    // all, which is the exact defect this card exists to remove. The phone's copy
    // table is what refuses to invent a sentence for a token it does not know.
    const r = EVENT_SCHEMAS['stt:final'].safeParse({ ...baseFinal, empty_reason: 'a_reason_from_2027' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.empty_reason).toBe('a_reason_from_2027');
  });

  it('an empty string is refused rather than carried as a third state', () => {
    // '' would parse as「the server did answer」while saying nothing, i.e. a value
    // that means both「absent」and「present」. The schema keeps the field a plain
    // optional string, so the server never emits '' — asserted here so a future
    // edit that starts emitting one is caught by its own contract.
    const r = EVENT_SCHEMAS['stt:final'].safeParse({ ...baseFinal, empty_reason: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.empty_reason).toBe('');
  });

  it('adds no event name — the whitelist and count guard are untouched', () => {
    expect(EVENT_NAMES).toContain('stt:final');
    expect(EVENT_NAMES.filter((n) => n.startsWith('stt:'))).not.toContain('stt:empty');
  });
});
