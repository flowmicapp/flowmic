// v0.2.4 — "is this the same PC / the same phone", on the server side.
//
// owner 2026-07-29: "the PC side needs a unique instance name or ID to tell whether it is the same PC; the phone too;
// on an external network the phone reaches us through the cloud relay, e.g. working away from the office, and on the intranet it uses the local LAN, but
// we should still be able to tell clearly whether they are the same phone and the same PC".
//
// This file pins the RESOLVE ORDER, which is where the whole feature can go
// wrong quietly. Two failure directions, and they are not symmetric:
//
//   · resolving too NARROWLY leaves a duplicate row — visible, annoying, and
//     already what the owner reported for phones;
//   · resolving too BROADLY merges two machines that are not the same one. The
//     winner rotates the loser's token, the loser re-registers, takes it back,
//     and the two ping-pong forever. Nothing in a device list would show WHY.
//
// So the order is: ① client_instance_id (exactly the pre-0.2.4 behaviour, so no
// installed machine can move) → ② machine_uid (the reinstall case ① cannot
// see) → ③ a genuinely new row. Every test below is one edge of that.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../src/room/registry';
import { planLimits } from '../src/billing/plans';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

type Db = ReturnType<typeof createDbConnection>;
let db: Db;

const MACHINE_A = 'pc-00112233445566aa';
const MACHINE_B = 'pc-ffeeddccbbaa9988';
const HANDSET_A = 'mb-0a0b0c0d0e0f0102';
const HANDSET_B = 'mb-9988776655443322';

function registry(mode: 'standalone' | 'saas' = 'standalone'): Registry {
  return new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode, limitsOf: () => planLimits('free') });
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
});
afterEach(() => db.close());

describe('registerPc — which physical machine is this', () => {
  it('① the instance id still wins, so no installed desktop moves', () => {
    // The compatibility guarantee. A machine that has been registering since
    // 0.1.x keeps landing on its own row whatever the uid says, which is what
    // makes this change safe to ship to an existing install.
    const reg = registry();
    const first = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-aaaaaaaaaaaaa' });
    const again = reg.registerPc({
      device_name: 'PC',
      user_id: 'u1',
      client_instance_id: 'inst-aaaaaaaaaaaaa',
      machine_uid: MACHINE_A,
    });
    expect(again.pc.id).toBe(first.pc.id);
    expect(db.pcs.listByUser('u1')).toHaveLength(1);
  });

  it('② a REINSTALL (new instance id, same machine) reuses the row instead of orphaning it', () => {
    // The case ① structurally cannot cover. Losing credentials.bin mints a new
    // uuid, so the machine used to become a SECOND pc_devices row while every
    // phone paired to the first one kept pointing at a row nothing would ever
    // connect to again.
    const reg = registry();
    const before = reg.registerPc({
      device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-old-0000000000', machine_uid: MACHINE_A,
    });
    const pairing = reg.pairMobile({ short_code: before.pc.short_code, mobile_name: 'PLA-AL10-921d' });

    const after = reg.registerPc({
      device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-new-1111111111', machine_uid: MACHINE_A,
    });
    expect(after.pc.id).toBe(before.pc.id);
    expect(db.pcs.listByUser('u1')).toHaveLength(1);
    // …and the phone that was paired to it is still paired to it.
    expect(db.mobiles.findById(pairing.mobile.id)?.pc_device_id).toBe(before.pc.id);
  });

  it('② adopts the new instance id, so the NEXT registration takes the ① path', () => {
    const reg = registry();
    const before = reg.registerPc({
      device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-old-0000000000', machine_uid: MACHINE_A,
    });
    reg.registerPc({
      device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-new-1111111111', machine_uid: MACHINE_A,
    });
    expect(db.pcs.findById(before.pc.id)?.client_instance_id).toBe('inst-new-1111111111');
    expect(db.pcs.findByClientInstance('u1', 'inst-new-1111111111')?.id).toBe(before.pc.id);
  });

  it('a DIFFERENT machine is still a different row', () => {
    const reg = registry();
    reg.registerPc({ device_name: 'A', user_id: 'u1', client_instance_id: 'inst-a-000000000000', machine_uid: MACHINE_A });
    reg.registerPc({ device_name: 'B', user_id: 'u1', client_instance_id: 'inst-b-000000000000', machine_uid: MACHINE_B });
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
  });

  it('a machine that names NO uid never merges into one that did', () => {
    // The desktop returns None when it cannot read the machine id. That must
    // read as 「no answer」 and fall straight through to a new row — never as
    // 「matches whichever row also has no answer」.
    const reg = registry();
    const a = reg.registerPc({ device_name: 'A', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
    const b = reg.registerPc({ device_name: 'B', user_id: 'u1', client_instance_id: 'inst-b-000000000000' });
    expect(b.pc.id).not.toBe(a.pc.id);
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
    // Both rows carry NULL, and a third uid-less machine still does not match.
    expect(db.pcs.listByMachineUid('u1', '')).toEqual([]);
  });

  it('the uid is scoped to the account — one machine, two accounts, two rows', () => {
    // A shared office PC under two FlowMic accounts is two independent
    // relationships; matching across users would hand one account's row to
    // another, which is an authorization failure, not a merge.
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
    const reg = registry();
    reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-1-000000000000', machine_uid: MACHINE_A });
    reg.registerPc({ device_name: 'PC', user_id: 'u2', client_instance_id: 'inst-2-000000000000', machine_uid: MACHINE_A });
    expect(db.pcs.listByUser('u1')).toHaveLength(1);
    expect(db.pcs.listByUser('u2')).toHaveLength(1);
  });

  it('② takes the NEWEST row when a pre-0.2.4 DB already holds duplicates', () => {
    // The migration reality: databases that predate this column can already
    // contain the very duplicates it exists to stop creating. Picking the
    // newest is picking the one the machine most recently used.
    const reg = registry();
    const older = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-1-000000000000' });
    const newer = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-2-000000000000' });
    // Simulate the backfill both rows would get from one machine.
    db.pcs.setMachineUid(older.pc.id, MACHINE_A);
    db.pcs.setMachineUid(newer.pc.id, MACHINE_A);
    const resolved = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-3-000000000000', machine_uid: MACHINE_A });
    expect(resolved.pc.id).toBe(newer.pc.id);
    expect(db.pcs.listByUser('u1')).toHaveLength(2); // nothing new minted
  });

  it('a returning machine consumes NO plan slot', () => {
    // Same reasoning as the pre-existing instance-id branch: charging a device
    // for coming back is the off-by-one that makes a limit unrecoverable.
    const reg = registry('saas');
    reg.registerPc({ device_name: 'A', user_id: 'u1', client_instance_id: 'inst-a-000000000000', machine_uid: MACHINE_A });
    expect(() =>
      reg.registerPc({ device_name: 'A', user_id: 'u1', client_instance_id: 'inst-a2-00000000000', machine_uid: MACHINE_A }),
    ).not.toThrow();
    expect(db.pcs.listByUser('u1')).toHaveLength(1);
  });
});

describe('the uid is BACKFILLED, never used as a lookup, on reconnect', () => {
  it('a row registered without a uid gains one on the next reconnect', () => {
    const reg = registry();
    const { pc, token } = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
    expect(db.pcs.findById(pc.id)?.machine_uid).toBeNull();
    reg.reconnectPc(token, 'inst-a-000000000000', MACHINE_A);
    expect(db.pcs.findById(pc.id)?.machine_uid).toBe(MACHINE_A);
  });

  it('reconnect resolves by TOKEN — a uid that matches another row changes nothing', () => {
    // The safety property: reconnect can only ever fill in a field on the row
    // the token already named. If it could LOOK UP by uid, a stale credential
    // would be able to walk onto a different machine's row.
    const reg = registry();
    const a = reg.registerPc({ device_name: 'A', user_id: 'u1', client_instance_id: 'inst-a-000000000000', machine_uid: MACHINE_A });
    const b = reg.registerPc({ device_name: 'B', user_id: 'u1', client_instance_id: 'inst-b-000000000000', machine_uid: MACHINE_B });
    const result = reg.reconnectPc(b.token, 'inst-b-000000000000', MACHINE_A);
    expect(result?.pc.id).toBe(b.pc.id);
    expect(result?.pc.id).not.toBe(a.pc.id);
  });
});

describe('pairMobile — which physical handset is this', () => {
  function pcCode(reg: Registry): string {
    return reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-a-000000000000' }).pc.short_code;
  }

  it('the device_uid is the reuse key, ahead of the name', () => {
    const reg = registry();
    const code = pcCode(reg);
    const first = reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d', device_uid: HANDSET_A });
    // The user renamed the phone in Android settings — the label changed, the
    // handset did not. v0.2.3 matched on the name and would have minted here.
    const again = reg.pairMobile({
      short_code: db.pcs.findById(first.pc.id)!.short_code,
      mobile_name: '我的手机',
      device_uid: HANDSET_A,
    });
    expect(again.mobile.id).toBe(first.mobile.id);
    expect(db.mobiles.listByPc(first.pc.id)).toHaveLength(1);
  });

  it('two handsets that report the SAME name stay two rows', () => {
    // The mirror risk of the v0.2.3 name match: two identical devices out of
    // the box can genuinely produce the same label.
    const reg = registry();
    const code = pcCode(reg);
    const a = reg.pairMobile({ short_code: code, mobile_name: 'Pixel 8', device_uid: HANDSET_A });
    reg.pairMobile({
      short_code: db.pcs.findById(a.pc.id)!.short_code,
      mobile_name: 'Pixel 8',
      device_uid: HANDSET_B,
    });
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(2);
  });

  it('the v0.2.3 NAME match still works for a phone that sends no uid', () => {
    // Dropping it would re-open the duplicate case for every install still on
    // 0.2.3 — the exact users this was written for.
    const reg = registry();
    const code = pcCode(reg);
    const first = reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d' });
    const again = reg.pairMobile({
      short_code: db.pcs.findById(first.pc.id)!.short_code,
      mobile_name: 'PLA-AL10-921d',
    });
    expect(again.mobile.id).toBe(first.mobile.id);
  });

  it('a uid-less phone never captures a row that already claims a DIFFERENT handset', () => {
    // Otherwise an old phone sharing a name with a new one would take over its
    // pairing — and the new phone's next reconnect would find its token rotated.
    const reg = registry();
    const code = pcCode(reg);
    const owned = reg.pairMobile({ short_code: code, mobile_name: 'Pixel 8', device_uid: HANDSET_A });
    const other = reg.pairMobile({
      short_code: db.pcs.findById(owned.pc.id)!.short_code,
      mobile_name: 'Pixel 8',
    });
    expect(other.mobile.id).not.toBe(owned.mobile.id);
    expect(db.mobiles.listByPc(owned.pc.id)).toHaveLength(2);
  });

  it('a name match BACKFILLS the uid, so the name stops being load-bearing', () => {
    const reg = registry();
    const code = pcCode(reg);
    const first = reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d' });
    expect(db.mobiles.findById(first.mobile.id)?.device_uid).toBeNull();
    reg.pairMobile({
      short_code: db.pcs.findById(first.pc.id)!.short_code,
      mobile_name: 'PLA-AL10-921d',
      device_uid: HANDSET_A,
    });
    expect(db.mobiles.findById(first.mobile.id)?.device_uid).toBe(HANDSET_A);
  });

  it('mobile:reconnect backfills the uid without moving the pairing', () => {
    const reg = registry();
    const code = pcCode(reg);
    const first = reg.pairMobile({ short_code: code, mobile_name: 'PLA-AL10-921d' });
    const back = reg.reconnectMobile(first.token, HANDSET_A);
    expect(back?.mobile.id).toBe(first.mobile.id);
    expect(db.mobiles.findById(first.mobile.id)?.device_uid).toBe(HANDSET_A);
  });

  it('the uid is scoped to ONE PC — the same phone on two PCs is two pairings', () => {
    // Two PCs are two relationships with two tokens; disconnect on one must not touch
    // the other. This is also the LAN/cloud shape, and it IS correct there.
    const reg = registry();
    const a = reg.registerPc({ device_name: 'pc-a', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
    const b = reg.registerPc({ device_name: 'pc-b', user_id: 'u1', client_instance_id: 'inst-b-000000000000' });
    reg.pairMobile({ short_code: a.pc.short_code, device_uid: HANDSET_A, mobile_name: 'P' });
    reg.pairMobile({ short_code: b.pc.short_code, device_uid: HANDSET_A, mobile_name: 'P' });
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(1);
    expect(db.mobiles.listByPc(b.pc.id)).toHaveLength(1);
  });
});

describe('migration — the two columns land on a database that predates them', () => {
  it('a fresh DB has both columns and both default to NULL', () => {
    // The honest default. A column that defaulted to '' would make every legacy
    // row look like it shared an identity with every other legacy row.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
    const paired = reg.pairMobile({ short_code: pc.short_code });
    expect(db.pcs.findById(pc.id)?.machine_uid).toBeNull();
    expect(db.mobiles.findById(paired.mobile.id)?.device_uid).toBeNull();
  });

  it('listByMachineUid refuses to match on an empty key', () => {
    // The one query that could merge strangers. `WHERE machine_uid=''` would
    // happily collect every row anyone stamped with a blank.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'PC', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
    db.pcs.setMachineUid(pc.id, '');
    expect(db.pcs.listByMachineUid('u1', '')).toEqual([]);
  });
});

// ── card ACC-1 (2026-08-15) — one machine, two accounts, stranded phones ─────
// Measured on the relay that day (journal 11:06→11:17): the desktop signed into
// a fresh account (new pc_id e4171936, new room); the tablet stayed
// legitimately re-admitted into the OLD room c7dddf71 and every utterance ended
// `relay: inject:request but no PC in room` — answered, queued, and waiting for
// a PC whose return was impossible (the desktop app is single-account). Nothing
// anywhere could ever tell it to stop waiting. The registration is the one
// moment the server can KNOW the old registration is dead, and revocation (not
// release) is what turns the forever-wait into the phone's existing one-scan
// re-pair copy.
describe('reapCrossAccountSiblings — a machine changing accounts frees its old phones', () => {
  it('🔴 registering under account B revokes account A\'s pairings for the SAME machine', () => {
    const reg = registry('saas');
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
    const a = reg.registerPc({ device_name: 'PC', user_id: 'u1', machine_uid: MACHINE_A });
    const paired = reg.pairMobile({ short_code: a.pc.short_code, pcid: a.pc.pcid ?? undefined, mobile_name: 'tablet', device_uid: HANDSET_A, user_id: 'u1' });
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(1);

    reg.registerPc({ device_name: 'PC', user_id: 'u2', machine_uid: MACHINE_A });
    const displaced = reg.reapCrossAccountSiblings(MACHINE_A, 'u2');

    expect(displaced).toEqual([{ room_uuid: a.pc.room_uuid, pairing_ids: [paired.mobile.id] }]);
    // The pairing row is GONE — revoked, not released: the reconnect ladder must
    // meet AUTH_TOKEN_INVALID and the phone must say re-pair, not keep waiting.
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(0);
    expect(db.mobiles.findById(paired.mobile.id)).toBeNull();
  });

  it('the SAME account re-registering reaps nothing (the everyday path)', () => {
    const reg = registry('saas');
    const a = reg.registerPc({ device_name: 'PC', user_id: 'u1', machine_uid: MACHINE_A });
    reg.pairMobile({ short_code: a.pc.short_code, pcid: a.pc.pcid ?? undefined, mobile_name: 'tablet', device_uid: HANDSET_A, user_id: 'u1' });
    expect(reg.reapCrossAccountSiblings(MACHINE_A, 'u1')).toEqual([]);
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(1);
  });

  it('a DIFFERENT machine under another account is untouched — machines never merge', () => {
    const reg = registry('saas');
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
    const a = reg.registerPc({ device_name: 'PC-A', user_id: 'u1', machine_uid: MACHINE_A });
    reg.pairMobile({ short_code: a.pc.short_code, pcid: a.pc.pcid ?? undefined, mobile_name: 'tablet', device_uid: HANDSET_A, user_id: 'u1' });
    reg.registerPc({ device_name: 'PC-B', user_id: 'u2', machine_uid: MACHINE_B });
    expect(reg.reapCrossAccountSiblings(MACHINE_B, 'u2')).toEqual([]);
    expect(db.mobiles.listByPc(a.pc.id)).toHaveLength(1);
  });

  it('no machine_uid claimed ⇒ no reap — a blank must never cross accounts', () => {
    const reg = registry('saas');
    expect(reg.reapCrossAccountSiblings(undefined, 'u1')).toEqual([]);
  });

  it('a sibling with NO pairings is skipped — nothing to free, nothing reported', () => {
    const reg = registry('saas');
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
    reg.registerPc({ device_name: 'PC', user_id: 'u1', machine_uid: MACHINE_A });
    reg.registerPc({ device_name: 'PC', user_id: 'u2', machine_uid: MACHINE_A });
    expect(reg.reapCrossAccountSiblings(MACHINE_A, 'u2')).toEqual([]);
  });
});
