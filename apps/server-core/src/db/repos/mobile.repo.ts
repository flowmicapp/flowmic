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
  /** card S2-01 — which kind of end paired here ('app' | 'web'), or NULL for a
   *  row paired before the column existed. 🔴 NULL IS NOT 'app' AT THIS LAYER:
   *  the default has exactly one author, the protocol's `clientOriginOf`, and a
   *  repo that returned 'app' would be a second one. */
  client: string | null;
  /** card S2-01 — that end's own version string. Diagnostic; nothing branches on it. */
  client_version: string | null;
  /** card R-1 — the ANONYMOUS TRIAL IDENTITY this pairing spends while it is a
   *  web end with nobody signed in, or NULL. Deliberately NOT `user_id`: see the
   *  column's own DDL comment (db/schema.ts) for the two reasons, of which the
   *  load-bearing one is that `user_id` cascades and this must not.
   *
   *  🔴 A NON-NULL VALUE IS A LIVE ANONYMOUS ROW BY CONSTRUCTION, and readers
   *  rely on that rather than re-checking `users.anonymous`: the only writer is
   *  `auth/web-trial-identity.ts` (which writes an id it has just minted), and
   *  the foreign key empties the column the moment the sweep takes the identity. */
  trial_user_id: string | null;
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
  client?: string | null;
  client_version?: string | null;
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
  /** card S2-01 — mirror of `PcRepo.setClientDeclaration` on the handset side,
   *  minus the capability half (a microphone end declares no target caps — it is
   *  not a target). Unconditional and both fields at once: a phone that was the
   *  app and is now the browser page re-pairs into the SAME row (the reuse key is
   *  the device uid), so a write that only filled NULLs would leave the row
   *  describing whichever end got there first. */
  setClientOrigin(id: string, client: string | null, client_version: string | null): void;
  /**
   * card R-1 — stamp (or clear) the anonymous trial identity this pairing
   * spends. The ONE writer is `auth/web-trial-identity.ts`.
   *
   * Unconditional, like its two neighbours above, and for a sharper reason: the
   * value it overwrites can only be a NULL (a fresh row, or one the anonymous
   * sweep emptied through the foreign key). If it ever overwrote a LIVE identity
   * that would be a second identity for one instance, which is the thing this
   * column exists to prevent — pinned by test/web-trial-identity.test.ts
   * ("a second unsigned admission reuses the identity rather than minting").
   */
  setTrialUser(id: string, trial_user_id: string | null): void;
  /**
   * 2026-08-31 multi-node — write a WHOLE pairing row that came from the writer,
   * on a replica. Sole caller: the handshake read-through
   * (node/token-read-through.ts).
   *
   * 🔴 `ON CONFLICT(id) DO UPDATE`, deliberately NOT `INSERT OR REPLACE` — the
   * same argument as `PcRepo.upsertReplicated`, stated here too because the
   * next person to touch this file will not have that one open: REPLACE deletes
   * the conflicting row first, and a delete on this table under
   * `PRAGMA foreign_keys = ON` is the shape that silently takes other rows with
   * it. Keeping both spellings identical also means「the two upserts behave the
   * same way」is true by construction rather than by memory.
   *
   * ⚠️ Throws on a UNIQUE violation (`mobile_token` under a different id) and on
   * an FK violation (`pc_device_id` not present locally). Both are「the row did
   * not land」, and the caller must refuse rather than proceed — which is why
   * the PC row is upserted FIRST and both live in one transaction.
   */
  upsertReplicated(row: MobileRecord): void;
}

function toRecord(r: Record<string, unknown>): MobileRecord {
  return {
    id: r.id as string,
    user_id: (r.user_id as string | null) ?? null,
    pc_device_id: r.pc_device_id as string,
    mobile_token: r.mobile_token as string,
    mobile_name: (r.mobile_name as string | null) ?? 'Phone',
    device_uid: (r.device_uid as string | null) ?? null,
    client: (r.client as string | null) ?? null,
    client_version: (r.client_version as string | null) ?? null,
    trial_user_id: (r.trial_user_id as string | null) ?? null,
    paired_at: r.paired_at as string,
    last_seen_at: (r.last_seen_at as string | null) ?? null,
  };
}

export function makeMobileRepo(db: DatabaseSync): MobileRepo {
  const ins = db.prepare(
    `INSERT INTO mobile_pairings (id, user_id, pc_device_id, mobile_token, mobile_name, device_uid, client, client_version, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,NULL)`,
  );
  const byId = db.prepare('SELECT * FROM mobile_pairings WHERE id=?');
  const byToken = db.prepare('SELECT * FROM mobile_pairings WHERE mobile_token=?');
  const byPc = db.prepare('SELECT * FROM mobile_pairings WHERE pc_device_id=? ORDER BY paired_at ASC');
  const setTokenStmt = db.prepare('UPDATE mobile_pairings SET mobile_token=? WHERE id=?');
  const setUidStmt = db.prepare('UPDATE mobile_pairings SET device_uid=? WHERE id=?');
  // ONE statement for both, for the reason PcRepo.setClientDeclaration spells
  // out: they are one declaration made in one frame.
  const setClientStmt = db.prepare('UPDATE mobile_pairings SET client=?, client_version=? WHERE id=?');
  const setTrialUserStmt = db.prepare('UPDATE mobile_pairings SET trial_user_id=? WHERE id=?');
  const delStmt = db.prepare('DELETE FROM mobile_pairings WHERE id=?');
  // See `MobileRepo.upsertReplicated` for why this is ON CONFLICT DO UPDATE and
  // never INSERT OR REPLACE.
  const upsertStmt = db.prepare(
    `INSERT INTO mobile_pairings
       (id, user_id, pc_device_id, mobile_token, mobile_name, device_uid, client, client_version, trial_user_id, paired_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       user_id=excluded.user_id,
       pc_device_id=excluded.pc_device_id,
       mobile_token=excluded.mobile_token,
       mobile_name=excluded.mobile_name,
       device_uid=excluded.device_uid,
       client=excluded.client,
       client_version=excluded.client_version,
       trial_user_id=excluded.trial_user_id,
       paired_at=excluded.paired_at,
       last_seen_at=excluded.last_seen_at`,
  );
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
        input.client ?? null,
        input.client_version ?? null,
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
    setClientOrigin(id, client, client_version): void {
      setClientStmt.run(client, client_version, id);
    },
    setTrialUser(id, trial_user_id): void {
      setTrialUserStmt.run(trial_user_id, id);
    },
    upsertReplicated(row): void {
      upsertStmt.run(
        row.id,
        row.user_id,
        row.pc_device_id,
        row.mobile_token,
        row.mobile_name,
        row.device_uid,
        row.client,
        row.client_version,
        // card R-1 — carried across nodes for the FK's sake as much as the
        // rule's: a replica that dropped it would meter an unsigned web session
        // to the PC owner, silently, which is the defect the column closes.
        row.trial_user_id,
        row.paired_at,
        row.last_seen_at,
      );
    },
  };
}
