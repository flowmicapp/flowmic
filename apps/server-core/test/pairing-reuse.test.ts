// v0.2.3 — RE-pairing the same handset must reuse its row, not mint a second.
//
// owner 2026-07-29, from the devices page: THREE pairings for one phone, two of
// them dead, and no way to tell which was which. The trail:
//
//   · `pairMobile` always minted ("every call here is a NEW pairing"). The
//     comment justified it by saying a returning phone reconnects by token —
//     true, EXCEPT when the token is gone: an APK reinstall, a deleted entry, a
//     re-scan of the same QR. All three come back through pairMobile.
//   · the phone's own store DOES replace (same `connectionIdentity`), so the
//     old row survived only on the SERVER. Nothing ever collected it.
//
// The PC side never had this problem: `registerPc` recognises a returning
// machine by `client_instance_id` and rotates its token in place. This suite
// pins the same behaviour for phones, keyed on the name the phone sends —
// `model-<4-char ANDROID_ID hash>` since 0.1.10, which survives a reinstall and is
// therefore exactly the identity the duplicate case needed.
//
// The negative half matters as much: an UNNAMED client must still mint, because
// the `Phone-<4>` fallback is derived from the pairing's own uuid and can never
// identify a handset. Merging on it would fuse two real phones into one row.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../src/room/registry';
import { planLimits } from '../src/billing/plans';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

type Db = ReturnType<typeof createDbConnection>;
let db: Db;

function registry(mode: 'standalone' | 'saas' = 'standalone'): Registry {
  return new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode, limitsOf: () => planLimits('free') });
}

/** A registered PC plus a freshly minted code, ready to pair against. */
function pcWithCode(reg: Registry, user_id = 'u1') {
  const { pc } = reg.registerPc({ device_name: 'office-pc', user_id, client_instance_id: 'inst-1' });
  return { pc, code: pc.short_code };
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
});
afterEach(() => db.close());

describe('v0.2.3 — a returning handset reuses its pairing row', () => {
  it('re-pairing the same name to the same PC keeps ONE row and rotates the token', () => {
    const reg = registry();
    const { pc, code } = pcWithCode(reg);

    const first = reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d' });
    const second = reg.pairMobile({ short_code: pc.short_code, mobile_name: 'PLA-AL10-921d' });

    expect(db.mobiles.listByPc(pc.id)).toHaveLength(1);
    expect(second.mobile.id).toBe(first.mobile.id);
    // A fresh token — the phone lost the old one, that is WHY it re-paired.
    expect(second.token).not.toBe(first.token);
    // …and the old token is dead, so a stale client cannot keep using it.
    expect(db.mobiles.findByToken(first.token)).toBeNull();
    expect(db.mobiles.findByToken(second.token)?.id).toBe(first.mobile.id);
  });

  it('a DIFFERENT handset still gets its own row', () => {
    const reg = registry();
    const { pc, code } = pcWithCode(reg);
    reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d' });
    reg.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel 8-3f2a' });
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(2);
  });

  it('an UNNAMED client keeps minting — a Phone-<4> fallback is not an identity', () => {
    // The fallback suffix comes from the pairing's own uuid, so two unnamed
    // clients would collide into one row if this reused. Two phones must never
    // become one row just because neither said its name.
    const reg = registry();
    const { pc, code } = pcWithCode(reg);
    reg.pairMobile({ short_code: code });
    reg.pairMobile({ short_code: pc.short_code });
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(2);
  });

  it('the name match is scoped to ONE PC — the same phone on two PCs is two pairings', () => {
    // Two PCs are two independent relationships; disconnect on one must not touch the
    // other. (This is also the shape of the LAN/cloud split: two servers, two
    // rows, and that IS correct — what was wrong was two rows on ONE server.)
    const reg = registry();
    const a = reg.registerPc({ device_name: 'pc-a', user_id: 'u1', client_instance_id: 'inst-a' });
    const b = reg.registerPc({ device_name: 'pc-b', user_id: 'u1', client_instance_id: 'inst-b' });
    reg.pairMobile({ short_code: a.pc.short_code, mobile_name: 'PLA-AL10-921d' });
    reg.pairMobile({ short_code: b.pc.short_code, mobile_name: 'PLA-AL10-921d' });
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(1);
    expect(db.mobiles.listByPc(b.pc.id)).toHaveLength(1);
  });

  it('a returning handset consumes NO new slot (the recoverable-limit rule)', () => {
    // Same reasoning as registerPc's existing branch: charging a device for
    // coming back is the off-by-one that makes a limit impossible to recover
    // from — the Free plan allows 2 phones, and re-pairing the same two must
    // never be the thing that locks the user out.
    const reg = registry('saas');
    const { pc, code } = pcWithCode(reg);
    // 0.2.66 — this is the one SAAS case in this file, so it is the one that has
    // to name its target PC (owner 2026-08-14; a bare code is refused with
    // PAIR_PCID_REQUIRED). The standalone cases above deliberately still pair
    // with a bare code: proving the LAN path is UNCHANGED is worth more here than
    // making every case in the file look alike.
    const pcid = pc.pcid ?? undefined;
    expect(pcid).toMatch(/^\d{9}$/); // saas registration really did mint one
    reg.pairMobile({ short_code: code, pcid, mobile_name: 'A-0001', user_id: 'u1' });
    reg.pairMobile({ short_code: pc.short_code, pcid, mobile_name: 'B-0002', user_id: 'u1' });
    // At the Free ceiling (2). Re-pairing either one must still work.
    expect(() =>
      reg.pairMobile({ short_code: pc.short_code, pcid, mobile_name: 'A-0001', user_id: 'u1' }),
    ).not.toThrow();
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(2);
    // A genuinely THIRD phone is still refused — the ceiling did not move.
    expect(() =>
      reg.pairMobile({ short_code: pc.short_code, pcid, mobile_name: 'C-0003', user_id: 'u1' }),
    ).toThrow();
  });

  it('trims the claimed name before matching, so whitespace cannot fork a row', () => {
    const reg = registry();
    const { pc, code } = pcWithCode(reg);
    const first = reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d' });
    const again = reg.pairMobile({ short_code: pc.short_code, mobile_name: '  PLA-AL10-921d  ' });
    expect(again.mobile.id).toBe(first.mobile.id);
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(1);
  });
});
