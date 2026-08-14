// R6 T-8 — the `pc:list-mobiles` ack projection is ZERO-SECRET by construction.
//
// The rows behind it (mobile_pairings) carry `mobile_token` — the bearer secret a
// phone reconnects with. The whole point of a wire projection is that the secret
// column has NO field on the wire schema, so a future careless spread cannot
// smuggle it out (the REST /api/cloud/devices projection is held to the same
// rule, W1). These tests pin that property at the CONTRACT level, independent of
// any one server handler.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:list-mobiles);
//           docs/rebuild/05-DATA-MODEL.md §7 (mobile_token is a secret)

import { describe, it, expect } from 'vitest';
import {
  PcListMobilesAckSchema,
  PcListMobilesSchema,
  PcPairedMobileSchema,
} from '../src/protocol-schemas';

const ROW = {
  pairing_id: 'pair-1',
  mobile_name: 'Pixel 9',
  paired_at: '2026-07-25T10:00:00.000Z',
  last_seen_at: '2026-07-25T10:30:00.000Z',
  online: true,
};

describe('pc:list-mobiles request schema', () => {
  it('is an empty payload — the PC identity is the scope, nothing is addressable', () => {
    expect(PcListMobilesSchema.safeParse({}).success).toBe(true);
    expect(PcListMobilesSchema.safeParse(null).success).toBe(false);
  });

  it('cannot be pointed at another device (no id field exists to strip to)', () => {
    // A caller naming someone else's pc_device_id gets it DROPPED, never honoured.
    const parsed = PcListMobilesSchema.parse({ pc_device_id: 'someone-else' });
    expect(parsed).toEqual({});
    expect(Object.keys(parsed)).toHaveLength(0);
  });
});

describe('pc:list-mobiles ack projection', () => {
  it('accepts the public row shape', () => {
    expect(PcPairedMobileSchema.safeParse(ROW).success).toBe(true);
    expect(PcListMobilesAckSchema.safeParse({ mobiles: [ROW] }).success).toBe(true);
    expect(PcListMobilesAckSchema.safeParse({ mobiles: [] }).success).toBe(true);
  });

  it('STRIPS mobile_token even when the whole DB record is handed to it', () => {
    const dbRecord = {
      ...ROW,
      id: 'pair-1',
      user_id: 'default',
      pc_device_id: 'pc-1',
      mobile_token: 'S3CRET-token-value-32-chars-long-xxxx',
    };
    const out = PcPairedMobileSchema.parse(dbRecord);
    expect(out).not.toHaveProperty('mobile_token');
    expect(Object.keys(out).sort()).toEqual(
      ['last_seen_at', 'mobile_name', 'online', 'paired_at', 'pairing_id'],
    );
    expect(JSON.stringify(out)).not.toContain('S3CRET');
  });

  it('has no token-ish field in the declared shape at all', () => {
    const keys = Object.keys(PcPairedMobileSchema.shape);
    expect(keys.some((k) => /token|secret|key/i.test(k))).toBe(false);
  });

  it('requires online to be a REAL boolean — never absent, never a string', () => {
    // 「不得编造在线态」("must not fabricate an online state"): the field is
    // mandatory, so a server that cannot compute
    // real presence cannot ship a placeholder past this schema.
    const { online: _drop, ...withoutOnline } = ROW;
    expect(PcPairedMobileSchema.safeParse(withoutOnline).success).toBe(false);
    expect(PcPairedMobileSchema.safeParse({ ...ROW, online: 'yes' }).success).toBe(false);
  });

  it('allows a never-seen pairing (last_seen_at null) but not a blank name', () => {
    expect(PcPairedMobileSchema.safeParse({ ...ROW, last_seen_at: null }).success).toBe(true);
    expect(PcPairedMobileSchema.safeParse({ ...ROW, mobile_name: '' }).success).toBe(false);
  });
});
