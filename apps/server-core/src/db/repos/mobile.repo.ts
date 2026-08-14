// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (mobile_pairings), §7 (mobile_token)
//   Ported mechanism from legacy connection-factories.ts.

import type { DatabaseSync } from 'node:sqlite';

export interface MobileRecord {
  id: string;
  user_id: string | null;
  pc_device_id: string;
  mobile_token: string;
  mobile_name: string;
  /** v0.2.4 — this PHYSICAL handset, the same value whether it reached the PC
   *  over the LAN or the relay. Null for a row paired by a pre-0.2.4 build. */
  device_uid: string | null;
  paired_at: string;
  last_seen_at: string | null;
}

export interface MobileInsertInput {
  id: string;
  user_id?: string | null;
  pc_device_id: string;
  mobile_token: string;
  mobile_name?: string;
  device_uid?: string | null;
}

export interface MobileRepo {
  insert(input: MobileInsertInput): MobileRecord;
  findById(id: string): MobileRecord | null;
  findByToken(token: string): MobileRecord | null;
  listByPc(pc_device_id: string): MobileRecord[];
  remove(id: string): void;
  touchLastSeen(id: string, when: string): void;
  /** Rotate a pairing's token in place. v0.2.3 — lets a phone RE-PAIR to a PC it
   *  already has a row on without minting a second one (see Registry.pairMobile);
   *  the PC side has had exactly this for its own rows since GA-16. */
  setToken(id: string, token: string): void;
  /** v0.2.4 — stamp the handset uid onto an existing row. Unconditional (see
   *  PcRepo.setMachineUid): the phone is the authority on its own identity, and
   *  a row paired before the field existed gets it filled on first reconnect. */
  setDeviceUid(id: string, device_uid: string): void;
}

function toRecord(r: Record<string, unknown>): MobileRecord {
  return {
    id: r.id as string,
    user_id: (r.user_id as string | null) ?? null,
    pc_device_id: r.pc_device_id as string,
    mobile_token: r.mobile_token as string,
    mobile_name: (r.mobile_name as string | null) ?? 'Phone',
    device_uid: (r.device_uid as string | null) ?? null,
    paired_at: r.paired_at as string,
    last_seen_at: (r.last_seen_at as string | null) ?? null,
  };
}

export function makeMobileRepo(db: DatabaseSync): MobileRepo {
  const ins = db.prepare(
    `INSERT INTO mobile_pairings (id, user_id, pc_device_id, mobile_token, mobile_name, device_uid, last_seen_at)
     VALUES (?,?,?,?,?,?,NULL)`,
  );
  const byId = db.prepare('SELECT * FROM mobile_pairings WHERE id=?');
  const byToken = db.prepare('SELECT * FROM mobile_pairings WHERE mobile_token=?');
  const byPc = db.prepare('SELECT * FROM mobile_pairings WHERE pc_device_id=? ORDER BY paired_at ASC');
  const setTokenStmt = db.prepare('UPDATE mobile_pairings SET mobile_token=? WHERE id=?');
  const setUidStmt = db.prepare('UPDATE mobile_pairings SET device_uid=? WHERE id=?');
  const delStmt = db.prepare('DELETE FROM mobile_pairings WHERE id=?');
  const touchSeen = db.prepare('UPDATE mobile_pairings SET last_seen_at=? WHERE id=?');

  return {
    insert(input): MobileRecord {
      ins.run(
        input.id,
        input.user_id ?? null,
        input.pc_device_id,
        input.mobile_token,
        input.mobile_name && input.mobile_name.length > 0 ? input.mobile_name : 'Phone',
        input.device_uid ?? null,
      );
      return toRecord(byId.get(input.id) as Record<string, unknown>);
    },
    findById(id): MobileRecord | null {
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    findByToken(token): MobileRecord | null {
      const r = byToken.get(token) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    listByPc(pc_device_id): MobileRecord[] {
      return (byPc.all(pc_device_id) as Record<string, unknown>[]).map(toRecord);
    },
    remove(id): void {
      delStmt.run(id);
    },
    touchLastSeen(id, when): void {
      touchSeen.run(when, id);
    },
    setToken(id, token): void {
      setTokenStmt.run(token, id);
    },
    setDeviceUid(id, device_uid): void {
      setUidStmt.run(device_uid, id);
    },
  };
}
