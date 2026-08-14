import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import { SttPolishSchema, SETTINGS_KEY_STT_POLISH } from '../src';

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
