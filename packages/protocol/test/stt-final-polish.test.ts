import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import {
  SttPolishSchema,
  SETTINGS_KEY_STT_POLISH,
  DEFAULT_POLISH_STRENGTH,
  POLISH_STRENGTHS,
} from '../src';

// WP-R4-6 ②/④ — stt:final additive polish honest-signal fields + the stt.polish
// settings-value schema. Absence ⇔ polish not enabled this session; old payloads
// must still parse. No new event name, no PROTOCOL_SCHEMA_VERSION bump
// (additive-field only). `polish` is a closed applied|skipped enum; `polish_reason`
// is a PERMISSIVE string (additive forward-compat) — the canonical 4-value domain
// is a SERVER wire-mapping contract, not a schema gate.

const baseFinal = {
  text: '大家好。',
  confidence: 0.95,
  language: 'zh-CN',
  segment_idx: 0,
  is_segment: false,
  duration_ms: 1200,
} as const;

const parse = (extra: Record<string, unknown> = {}) =>
  safeParseEvent('stt:final', { ...baseFinal, ...extra });

describe('WP-R4-6 stt:final polish additive fields', () => {
  it('accepts a legacy stt:final with NO polish fields (round-trip: absent)', () => {
    expect(parse({}).success).toBe(true);
    const r = EVENT_SCHEMAS['stt:final'].safeParse(baseFinal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.polish).toBeUndefined();
      expect(r.data.polish_reason).toBeUndefined();
    }
  });

  it("accepts polish: 'applied' without a reason (round-trip: present)", () => {
    const r = parse({ polish: 'applied' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.polish).toBe('applied');
      expect(r.data.polish_reason).toBeUndefined();
    }
  });

  it("accepts polish: 'skipped' with each of the 4 canonical wire reasons", () => {
    for (const reason of ['timeout', 'llm_error', 'empty_output', 'guard_reject'] as const) {
      const r = parse({ polish: 'skipped', polish_reason: reason });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.polish).toBe('skipped');
        expect(r.data.polish_reason).toBe(reason);
      }
    }
  });

  it('rejects an unknown polish STATUS value (closed enum)', () => {
    expect(parse({ polish: 'failed' }).success).toBe(false);
  });

  it('accepts an arbitrary string polish_reason (permissive additive forward-compat)', () => {
    // Deliberate: the schema does NOT enum-lock the reason, so a future reason value
    // never breaks an old receiver (CLAUDE.md additive-field 优先). The 4-value
    // normalization is enforced by the server, verified in server-core tests.
    expect(parse({ polish: 'skipped', polish_reason: 'some_future_reason' }).success).toBe(true);
  });

  it('rejects a non-string polish_reason (type is still enforced)', () => {
    expect(parse({ polish: 'skipped', polish_reason: 42 }).success).toBe(false);
  });
});

describe('WP-R4-6 SttPolishSchema (stt.polish settings value)', () => {
  it('the SETTINGS_KEY_STT_POLISH constant equals its literal SSOT value', () => {
    expect(SETTINGS_KEY_STT_POLISH).toBe('stt.polish');
  });

  it('accepts {enabled:true} and {enabled:false}', () => {
    expect(SttPolishSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(SttPolishSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('rejects a missing / non-boolean enabled', () => {
    expect(SttPolishSchema.safeParse({}).success).toBe(false);
    expect(SttPolishSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(SttPolishSchema.safeParse(true).success).toBe(false);
  });

  it('is STRICT — rejects unexpected keys', () => {
    expect(SttPolishSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });
});

// ─── card C8: the correction-strength dial inside the same toggle ───────────
//
// The value is additive-optional on the wire and TOTAL in the code. These cases
// pin both halves, because they fail in opposite directions: a non-optional
// field breaks every row written before today, and an un-defaulted read makes
// `undefined` a third strength that no consumer handles.
describe('C8 SttPolishSchema.strength (correction strength)', () => {
  it('accepts both strengths', () => {
    expect(SttPolishSchema.safeParse({ enabled: true, strength: 'strict' }).success).toBe(true);
    expect(SttPolishSchema.safeParse({ enabled: true, strength: 'smooth' }).success).toBe(true);
  });

  it('ABSENT is legal and parses to undefined — every row written before C8 is one of these', () => {
    const r = SttPolishSchema.safeParse({ enabled: true });
    expect(r.success).toBe(true);
    expect(r.success && r.data.strength).toBeUndefined();
  });

  it('the documented default for an absent value is strict (the UNCHANGED behaviour)', () => {
    expect(DEFAULT_POLISH_STRENGTH).toBe('strict');
    expect(POLISH_STRENGTHS).toContain(DEFAULT_POLISH_STRENGTH);
  });

  it('rejects an unknown strength rather than silently degrading to strict', () => {
    // A permissive string here would let a typo ('smoooth', or a value from a
    // FUTURE client) parse and then resolve to strict, so the user would flip a
    // control and read no error while nothing changed — the 0.2.27 "a control
    // that changes nothing" shape. Rejecting makes it a loud
    // SETTINGS_SCHEMA_INVALID at the read boundary instead.
    expect(SttPolishSchema.safeParse({ enabled: true, strength: 'smoooth' }).success).toBe(false);
    expect(SttPolishSchema.safeParse({ enabled: true, strength: null }).success).toBe(false);
  });

  it('🔴 STILL STRICT with the new field — this is the deployment order, stated as a test', () => {
    // The mirror image of this assertion is the fact that governs the rollout: a
    // server built BEFORE this field rejects `{enabled, strength}` exactly the
    // way this rejects an unknown key. So the server halves ship first — the
    // relay AND the LAN server inside the desktop installer — and only then a
    // client that can emit `strength`.
    expect(SttPolishSchema.safeParse({ enabled: true, strength: 'smooth', extra: 1 }).success).toBe(false);
  });
});
