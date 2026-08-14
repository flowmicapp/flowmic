// v0.2.4 — `machine_uid` / `device_uid`, the two ADDITIVE identity fields.
//
// owner 2026-07-29:「应能明确知道是否都是同一台手机和同一台 PC」("must be able to
// clearly tell whether it's the same phone and the same PC each time"). No new
// event: EVENT_NAMES and the count guard are untouched at 58, because the answer
// to 「是不是同一台」("whether it's the same device") belongs on the frames that
// already carry identity, not on a
// frame of its own.
//
// The behaviour worth pinning is the DEGRADATION. `DeviceUid` is
// `.regex(...).optional().catch(undefined)`, which means a malformed uid is
// silently discarded instead of failing the frame. That is the right trade — a
// phone that could not pair because a cosmetic id had the wrong shape would be
// far worse than the duplicate row this prevents — but silence needs a test, or
// the next person to touch the primitive will not know it was a decision.

import { describe, it, expect } from 'vitest';
import { PcPairedMobileSchema, safeParseEvent } from '../src/protocol-schemas';

const TOKEN = 't'.repeat(32);
const PC_UID = 'pc-00112233445566aa';
const MB_UID = 'mb-0a0b0c0d0e0f0102';

describe('pc:register / pc:reconnect — machine_uid', () => {
  it('accepts a well-formed uid alongside the instance id', () => {
    const r = safeParseEvent('pc:register', {
      device_name: 'Studio PC',
      client_instance_id: 'pc-inst-0123456789',
      machine_uid: PC_UID,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.machine_uid).toBe(PC_UID);
  });

  it('a frame with NO uid still parses — every pre-0.2.4 desktop sends exactly this', () => {
    const r = safeParseEvent('pc:register', { device_name: 'Studio PC' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.machine_uid).toBeUndefined();
  });

  it('a MALFORMED uid degrades to absent instead of refusing the registration', () => {
    for (const bad of ['nonsense', 'PC-00112233445566AA', 'pc-zz', 'pc-0011', 42, null]) {
      const r = safeParseEvent('pc:register', {
        device_name: 'Studio PC',
        machine_uid: bad,
      });
      expect(r.success, JSON.stringify(bad)).toBe(true);
      expect(r.success && r.data.machine_uid, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('rides pc:reconnect too, so a row written before 0.2.4 gets backfilled', () => {
    const r = safeParseEvent('pc:reconnect', { token: TOKEN, machine_uid: PC_UID });
    expect(r.success && r.data.machine_uid).toBe(PC_UID);
  });

  it('the uid is NOT a substitute for the token — a reconnect without one still fails', () => {
    // Identity is not authorization. This field groups and recognises; it must
    // never be able to stand in for a credential.
    expect(safeParseEvent('pc:reconnect', { machine_uid: PC_UID }).success).toBe(false);
  });
});

describe('mobile:pair / mobile:reconnect — device_uid', () => {
  it('rides all three admission variants', () => {
    const variants: Record<string, unknown>[] = [
      { short_code: '1234', device_uid: MB_UID },
      { qr_payload: 'flowmic://pair?code=1234', device_uid: MB_UID },
      { cloud_instance: true, device_uid: MB_UID },
    ];
    for (const v of variants) {
      const r = safeParseEvent('mobile:pair', v);
      expect(r.success, JSON.stringify(v)).toBe(true);
      expect(r.success && (r.data as { device_uid?: string }).device_uid).toBe(MB_UID);
    }
  });

  it('a phone that sends neither name nor uid still pairs (the 0.1.x client)', () => {
    const r = safeParseEvent('mobile:pair', { short_code: '1234' });
    expect(r.success).toBe(true);
  });

  it('a malformed uid does not cost the user their pairing', () => {
    const r = safeParseEvent('mobile:pair', { short_code: '1234', device_uid: 'MB-NOPE' });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { device_uid?: string }).device_uid).toBeUndefined();
  });

  it('a PC uid on a phone frame parses but is not thereby a phone', () => {
    // The prefixes exist so the two can never be confused downstream. The shape
    // check cannot tell them apart (both match the regex), which is precisely
    // why the DERIVATION on each side is what guarantees the prefix — see the
    // desktop's pc_name.rs and the phone's device_label.dart tests.
    const r = safeParseEvent('mobile:pair', { short_code: '1234', device_uid: PC_UID });
    expect(r.success && (r.data as { device_uid?: string }).device_uid).toBe(PC_UID);
    expect(PC_UID.startsWith('pc-')).toBe(true);
    expect(MB_UID.startsWith('mb-')).toBe(true);
  });

  it('mobile:reconnect carries it for the backfill path', () => {
    const r = safeParseEvent('mobile:reconnect', { token: TOKEN, device_uid: MB_UID });
    expect(r.success && r.data.device_uid).toBe(MB_UID);
    // …and, as on the PC side, it cannot stand in for the token.
    expect(safeParseEvent('mobile:reconnect', { device_uid: MB_UID }).success).toBe(false);
  });
});

describe('pc:list-mobiles ack — device_uid on the row', () => {
  it('a row may carry the handset id, and null is a legal answer', () => {
    const ok = safeParseEvent('pc:list-mobiles', {});
    expect(ok.success).toBe(true);
    const base = {
      pairing_id: 'p1',
      mobile_name: 'Pixel 8-3f2a',
      paired_at: '2026-07-29T00:00:00.000Z',
      last_seen_at: null,
      online: true,
    };
    expect(PcPairedMobileSchema.safeParse({ ...base, device_uid: MB_UID }).success).toBe(true);
    // Null = a pairing made before the column existed. It must PARSE and must
    // never be read as 「matches the other null」 (that rule lives in the
    // desktop's derivePairedList, with its own negative control).
    expect(PcPairedMobileSchema.safeParse({ ...base, device_uid: null }).success).toBe(true);
    // Absent entirely = an older SERVER answering a newer desktop.
    expect(PcPairedMobileSchema.safeParse(base).success).toBe(true);
  });
});
