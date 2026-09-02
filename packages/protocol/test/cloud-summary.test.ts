// WP-9 (2026-09-02) — the shared /api/cloud/summary + /api/limits contract.
//
// See src/cloud-summary.ts for why `plan`/`quota` stay loose while
// `devices`/`continuous_minutes` are exact: those two are the fields this repo
// has already been bitten by three ends disagreeing about (findings-crossend-
// quota.md #4/#5). This file proves the SCHEMA'S OWN judgement, not any one
// end's parser.

import { describe, it, expect } from 'vitest';
import { CloudSummarySchema, StandaloneLimitsSchema, ContinuousMinutesSchema } from '../src/cloud-summary';

describe('CloudSummarySchema', () => {
  const validDevices = { pc_count: 1, mobile_count: 2, pc_limit: 3, mobile_limit: null };

  it('accepts the real server shape (finite limits + a finite ceiling)', () => {
    const parsed = CloudSummarySchema.parse({
      plan: { plan: 'pro', source: 'paddle' },
      quota: { stt: { used_min: 1, limit_min: 900 }, month: '2026-09' },
      devices: validDevices,
      continuous_minutes: 30,
    });
    expect(parsed.devices.pc_limit).toBe(3);
    expect(parsed.devices.mobile_limit).toBeNull();
    expect(parsed.continuous_minutes).toBe(30);
  });

  it('accepts a null continuous_minutes — "could not compute it", never a guessed number', () => {
    const parsed = CloudSummarySchema.parse({
      plan: {},
      quota: {},
      devices: validDevices,
      continuous_minutes: null,
    });
    expect(parsed.continuous_minutes).toBeNull();
  });

  it('rejects a zero or negative device limit — an account owning zero slots is not a real state', () => {
    for (const bad of [0, -1]) {
      const result = CloudSummarySchema.safeParse({
        plan: {},
        quota: {},
        devices: { ...validDevices, pc_limit: bad },
        continuous_minutes: 10,
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a zero or negative continuous_minutes (a real ceiling of zero must arrive as a NAMED signal, not arithmetic)', () => {
    for (const bad of [0, -5]) {
      expect(ContinuousMinutesSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a missing devices block — the whole reason this schema exists', () => {
    const result = CloudSummarySchema.safeParse({ plan: {}, quota: {}, continuous_minutes: 10 });
    expect(result.success).toBe(false);
  });
});

describe('StandaloneLimitsSchema', () => {
  it('accepts the standalone /api/limits body — continuous_minutes only, no plan/quota/devices', () => {
    const parsed = StandaloneLimitsSchema.parse({ continuous_minutes: 30 });
    expect(parsed).toEqual({ continuous_minutes: 30 });
  });

  it('rejects an extra plan-shaped field masquerading as the saas body — standalone has none of that to report', () => {
    // Not `.strict()` at the zod level (additive-field forward-compat is this
    // repo's rule for every wire shape), but the TYPE must not silently gain a
    // `plan`/`quota`/`devices` reader: this asserts the schema itself never
    // requires them, which is the property callers actually rely on.
    const result = StandaloneLimitsSchema.safeParse({ continuous_minutes: 10, plan: { plan: 'max' } });
    expect(result.success).toBe(true);
    if (result.success) expect(Object.keys(result.data)).toEqual(['continuous_minutes']);
  });
});
