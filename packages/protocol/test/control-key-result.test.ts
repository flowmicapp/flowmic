import { describe, it, expect } from 'vitest';
import {
  ControlKeySchema,
  ControlKeyResultSchema,
  CONTROL_KEY_RESULT_REASONS,
  CONTROL_KEY_CHORD_KINDS,
  CONTROL_KEY_PUNCTUATION_KINDS,
} from '../src/protocol-schemas-inject';
import { EVENT_SCHEMAS } from '../src/protocol-schemas';
import { EVENT_NAMES, isKnownEvent } from '../src/events';
import { ERROR_CODES } from '../src/error-codes';

// Card MP-14 — `control:key-result`, the receipt `control:key` never had.
//
// What is being pinned here is not "zod accepts an object". It is the four
// decisions the event was approved on, each of which is invisible to every
// other test in this package:
//   ① the name is on the whitelist and has a schema (the count guard proves
//      the NUMBER; this proves it is THIS name);
//   ② `request_id` on the PRESS is additive-optional, so an old phone's press
//      is still legal — the receipt then matches by kind + recency;
//   ③ the refusal vocabulary is a closed three-valued enum and NOT an error
//      code — the registry must be able to change size without this event's
//      meaning moving, and vice versa;
//   ④ `ok:true` is representable. A receipt that could only carry a failure
//      would make "no news" mean both "it worked" and "the relay dropped it".

describe('control:key-result — registration', () => {
  it('is on the whitelist and has exactly one schema', () => {
    expect(EVENT_NAMES).toContain('control:key-result');
    expect(isKnownEvent('control:key-result')).toBe(true);
    expect(EVENT_SCHEMAS['control:key-result']).toBe(ControlKeyResultSchema);
  });

  // 🔴 The press and the receipt must name keys from ONE list. Two enums that
  // "happen to agree" is the shape that lets a key become unanswerable the day
  // one of them grows: the desktop would emit a receipt the relay refuses, and
  // a refused receipt is the silence this card exists to delete.
  it('names keys from the same enum the press does', () => {
    for (const kind of [...CONTROL_KEY_CHORD_KINDS, ...CONTROL_KEY_PUNCTUATION_KINDS]) {
      expect(ControlKeySchema.safeParse({ kind }).success).toBe(true);
      expect(ControlKeyResultSchema.safeParse({ kind, ok: true }).success).toBe(true);
    }
    expect(ControlKeyResultSchema.safeParse({ kind: 'escape', ok: false }).success).toBe(false);
  });
});

describe('control:key-result — round trip', () => {
  it('carries a refusal with its reason and its correlation echo', () => {
    const frame = {
      request_id: 'k-1757000000000-7',
      kind: 'tab',
      ok: false,
      reason: 'unsupported_here',
    };
    const parsed = ControlKeyResultSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    // Verbatim: the receipt is matched on `request_id`, so a schema that
    // rewrote or defaulted it would settle the wrong press.
    expect(parsed.success && parsed.data).toEqual(frame);
  });

  // ④ — the success face is legal and carries no reason.
  it('carries a success with no reason', () => {
    const parsed = ControlKeyResultSchema.safeParse({ kind: 'enter', ok: true });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reason).toBeUndefined();
  });

  // The receipt has to stand alone for a client that lost the correlation id
  // (see ②). `kind` + `ok` is therefore the minimum legal frame.
  it('is legal without a request_id — that is the recency-matched case', () => {
    expect(ControlKeyResultSchema.safeParse({ kind: 'undo', ok: false, reason: 'no_target' }).success).toBe(true);
  });

  it('refuses a reason outside the three', () => {
    expect(ControlKeyResultSchema.safeParse({ kind: 'undo', ok: false, reason: 'busy' }).success).toBe(false);
    // ...and refuses an empty correlation id rather than carrying one that
    // matches nothing (the `NonEmpty` posture every other id on this wire has).
    expect(ControlKeyResultSchema.safeParse({ kind: 'undo', ok: true, request_id: '' }).success).toBe(false);
  });
});

describe('control:key — the press gained one additive optional field', () => {
  it('accepts a press with a request_id and one without', () => {
    expect(ControlKeySchema.safeParse({ kind: 'enter' }).success).toBe(true);
    expect(ControlKeySchema.safeParse({ kind: 'enter', request_id: 'k-1' }).success).toBe(true);
  });

  // 🔴 Additive-OPTIONAL, deliberately. Making it required would kill an older
  // phone's press at the relay's zod boundary, and a boundary refusal is
  // anonymous — the frame dies naming no field, which is worse than the weaker
  // recency match the optional key degrades to.
  it('still refuses an empty request_id, so a receipt can never match on ""', () => {
    expect(ControlKeySchema.safeParse({ kind: 'enter', request_id: '' }).success).toBe(false);
  });
});

describe('control:key-result — the reason enum is not the error registry', () => {
  // ③ — the two vocabularies must not converge. If someone later "promotes" a
  // reason into ERROR_CODES, this is what says out loud that they have just
  // given a keypress the vocabulary of a delivery (docs/rebuild/15 §2.0: the
  // delivery segment and the injection segment may not share words).
  it('shares no identifier with ERROR_CODES', () => {
    const codes = new Set(Object.keys(ERROR_CODES));
    for (const reason of CONTROL_KEY_RESULT_REASONS) {
      expect(codes.has(reason)).toBe(false);
      expect(codes.has(reason.toUpperCase())).toBe(false);
    }
  });

  it('has exactly three values, each leading to a different move', () => {
    // unsupported_here -> try another destination; no_target -> click into a
    // box; failed -> try again / read the far end's log. A fourth value would
    // have to name a fourth move.
    expect([...CONTROL_KEY_RESULT_REASONS]).toEqual(['unsupported_here', 'no_target', 'failed']);
  });
});
