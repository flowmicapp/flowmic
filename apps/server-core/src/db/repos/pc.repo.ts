// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (pc_devices), §7 (device_token)
//   Ported mechanism from legacy connection-factories.ts (short-code lookup
//   ordering, client_instance claim). Contract from @flowmic/protocol.

import type { DatabaseSync } from 'node:sqlite';

export interface PcRecord {
  id: string;
  user_id: string;
  device_name: string;
  client_instance_id: string | null;
  /** v0.2.4 — this PHYSICAL machine, the same value on every channel. Null on a
   *  row written before the column existed, and on the virtual cloud-instance row
   *  (which is not a machine at all). See protocol DeviceUid. */
  machine_uid: string | null;
  /** 0.2.66 — this PC's PUBLIC addressing id on the cloud relay: 9 decimal
   *  digits, minted server-side, stable for the life of the row. NULL on a
   *  standalone (LAN) row, on the virtual cloud-instance row, and on any row that has
   *  not registered since the column landed. It is NOT a secret and NOT a
   *  credential — it answers "which PC", the short code still answers "what is
   *  the secret" (04 §3.1 PCID addressing). */
  pcid: string | null;
  device_token: string;
  room_uuid: string;
  short_code: string;
  is_online: 0 | 1;
  last_seen_at: string | null;
  created_at: string;
}

export interface PcInsertInput {
  id: string;
  user_id: string;
  device_name: string;
  client_instance_id?: string | null;
  machine_uid?: string | null;
  device_token: string;
  room_uuid: string;
  short_code: string;
}

export interface PcRepo {
  insert(input: PcInsertInput): PcRecord;
  findById(id: string): PcRecord | null;
  findByToken(token: string): PcRecord | null;
  listByShortCode(code: string): PcRecord[];
  findByClientInstance(user_id: string, client_instance_id: string): PcRecord | null;
  /** v0.2.4 — every row this user has for one physical machine, NEWEST FIRST.
   *  A list rather than a `find` because the column is not unique on purpose:
   *  a machine that re-registered before 0.2.4 left older rows behind, and the
   *  caller has to be able to see that rather than be handed an arbitrary one. */
  listByMachineUid(user_id: string, machine_uid: string): PcRecord[];
  /** card ACC-1 (2026-08-15) — the SAME physical machine's rows under OTHER
   *  accounts, newest first. The one deliberate cross-account read on this
   *  table besides `findByPcid`, and like that one the scoping is the point:
   *  when a desktop registers under account B, account A's row for the same
   *  machine describes a PC that can no longer come back (the desktop app is
   *  single-account), and the registry uses this to stop A's phones waiting
   *  forever for it. Never exposed over any wire. */
  listByMachineUidOtherUsers(machine_uid: string, except_user_id: string): PcRecord[];
  /** 0.2.66 — the single PC a PCID addresses, or null.
   *
   *  🔴 DELIBERATELY NOT USER-SCOPED, unlike `findByClientInstance` and
   *  `listByMachineUid` right above it. Do not 「finish the pattern」 by adding a
   *  user_id parameter: this lookup runs during `mobile:pair`, BEFORE the phone
   *  has any account of its own — a phone pairs by knowing a PCID and a live
   *  code, and inherits the PC owner's account from the row this returns
   *  (registry.pairMobile). Scoping it by the caller's user would make the
   *  lookup ask a question the caller cannot answer yet, and every pairing would
   *  fail. The PCID is itself the complete addressing (04 §3.1); the SECRET half
   *  is checked afterwards against this row's own short code.
   *
   *  Uniqueness is the database's, via the partial unique index on `pcid`
   *  (connection.ts), so 「the single PC」 is a guarantee and not a hope. */
  findByPcid(pcid: string): PcRecord | null;
  /** 0.2.66 — write this row's PCID. Fails loudly (SQLite UNIQUE violation)
   *  rather than silently doing nothing on a collision: the caller
   *  (registry.mintPcid) retries with a fresh draw, and a swallowed collision
   *  would leave a PC unaddressable while looking successful. */
  setPcid(id: string, pcid: string): void;
  /** Stamp the machine uid. Unconditional — unlike `claimClientInstance` this
   *  fills NULLs AND corrects a stale value, because the uid is derived from
   *  the hardware and the client is the authority on it. */
  setMachineUid(id: string, machine_uid: string): void;
  setOnline(id: string, online: boolean): void;
  /** GA-07: stamp last_seen_at WITHOUT touching is_online. `heartbeat` proves
   *  activity, not a state transition — setOnline would rewrite a flag this
   *  event knows nothing about. */
  touchLastSeen(id: string, when: string): void;
  setDeviceName(id: string, name: string): void;
  setShortCode(id: string, code: string): void;
  setToken(id: string, token: string): void;
  claimClientInstance(id: string, value: string): boolean;
  /** v0.2.4 — OVERWRITE the instance id (the machine-uid resolve path adopting
   *  a freshly-minted credential file). `UPDATE OR IGNORE`: the partial unique
   *  index on (user_id, client_instance_id) means another row could already own
   *  this value, and losing that race must be a no-op, never a throw that fails
   *  a registration. Returns whether it landed so the caller can tell. */
  adoptClientInstance(id: string, value: string): boolean;
  listByUser(user_id: string): PcRecord[];
  /**
   * D11 — hard-delete ONE pc_devices row. THE self-service escape hatch: a
   * free-tier user who reinstalls Windows twice has no other way off the
   * device ceiling (`room/registry.ts`'s `ensurePcSlot` counts live rows via
   * `listByUser(...).filter(isRealPc)`, recomputed fresh on every call — there
   * is no cache to invalidate, so a row removed here is a slot freed on the
   * very next `registerPc`).
   *
   * No ownership check inside the repo (same shape as `mobile.repo.ts`'s
   * `remove`): the caller (an HTTP route, or the reaper below) is the one
   * that knows WHO is allowed to delete WHICH row, and re-deciding that here
   * would be a second place answering a question with exactly one owner.
   *
   * `mobile_pairings.pc_device_id REFERENCES pc_devices(id) ON DELETE CASCADE`
   * (schema.ts) — with `PRAGMA foreign_keys = ON` (schema.ts:41) this ALSO
   * removes every mobile pairing that pointed at the device, so a caller never
   * has to remember to clean those up separately.
   */
  remove(id: string): void;
  /**
   * D11 — every row that is BOTH offline right now AND has not been seen
   * since `cutoffIso`, excluding `excludeClientInstanceId` (the F-3140 virtual
   * "cloud-instance" row, which is not a machine and must never be swept as one).
   *
   * 🔴 `is_online = 0` is required, not merely `last_seen_at < cutoff`: a
   * currently-connected device must never be pruned no matter how old its
   * `created_at` is (a long-lived, always-on PC is the opposite of abandoned).
   * `setOnline(id, false)` (below) stamps `last_seen_at` at the moment of
   * disconnect, so `(is_online=0 AND last_seen_at < cutoff)` genuinely reads
   * 「disconnected a long time ago and never reconnected since」.
   *
   * `COALESCE(last_seen_at, created_at)` — NOT `last_seen_at < cutoff` alone —
   * because a row that has NEVER connected has `last_seen_at IS NULL` forever,
   * and a bare `<` comparison against NULL is never true in SQL: that row
   * would silently never age out under a `last_seen_at`-only cutoff, which is
   * exactly the kind of unbounded row this method exists to catch. Falling
   * back to `created_at` means an abandoned pairing that was minted and never
   * once used ages out on its OWN creation time instead of living forever.
   *
   * `client_instance_id IS NULL OR client_instance_id != ?` (not a bare `!=`):
   * SQL's `!=` against NULL is never true, so a bare `!=` would silently
   * EXCLUDE every pre-0.2.4 row (client_instance_id backfilled NULL) from ever
   * being swept — the opposite of this method's job for those legitimate old
   * rows.
   */
  listStaleOffline(cutoffIso: string, excludeClientInstanceId: string): PcRecord[];
}

function toRecord(r: Record<string, unknown>): PcRecord {
  return {
    id: r.id as string,
    user_id: r.user_id as string,
    device_name: r.device_name as string,
    client_instance_id: (r.client_instance_id as string | null) ?? null,
    machine_uid: (r.machine_uid as string | null) ?? null,
    pcid: (r.pcid as string | null) ?? null,
    device_token: r.device_token as string,
    room_uuid: r.room_uuid as string,
    short_code: r.short_code as string,
    is_online: (r.is_online as number) === 1 ? 1 : 0,
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

export function makePcRepo(db: DatabaseSync): PcRepo {
  const ins = db.prepare(
    `INSERT INTO pc_devices (id, user_id, device_name, client_instance_id, machine_uid, device_token, room_uuid, short_code, is_online, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,0,NULL)`,
  );
  const byId = db.prepare('SELECT * FROM pc_devices WHERE id=?');
  const byToken = db.prepare('SELECT * FROM pc_devices WHERE device_token=?');
  const allByCode = db.prepare('SELECT * FROM pc_devices WHERE short_code=? ORDER BY created_at DESC');
  const byInstance = db.prepare('SELECT * FROM pc_devices WHERE user_id=? AND client_instance_id=?');
  // `rowid DESC` is not decoration: `created_at` defaults to `datetime('now')`,
  // which is SECOND-granular, so two rows written in the same second tie and
  // SQLite is free to return either. In production the duplicates this query
  // exists for are days apart and it never showed — a test that made both rows
  // at once is what surfaced it. rowid is monotonic per insert, so the order is
  // now total and 「newest」 actually means newest.
  const byMachine = db.prepare(
    'SELECT * FROM pc_devices WHERE user_id=? AND machine_uid=? ORDER BY created_at DESC, rowid DESC',
  );
  const setMachineStmt = db.prepare('UPDATE pc_devices SET machine_uid=? WHERE id=?');
  const byMachineOther = db.prepare(
    'SELECT * FROM pc_devices WHERE machine_uid=? AND user_id<>? ORDER BY created_at DESC, rowid DESC',
  );
  const byPcid = db.prepare('SELECT * FROM pc_devices WHERE pcid=?');
  const setPcidStmt = db.prepare('UPDATE pc_devices SET pcid=? WHERE id=?');
  const adoptInstanceStmt = db.prepare('UPDATE OR IGNORE pc_devices SET client_instance_id=? WHERE id=?');
  const setOnlineStmt = db.prepare('UPDATE pc_devices SET is_online=?, last_seen_at=? WHERE id=?');
  const touchSeenStmt = db.prepare('UPDATE pc_devices SET last_seen_at=? WHERE id=?');
  const setNameStmt = db.prepare('UPDATE pc_devices SET device_name=? WHERE id=?');
  const setCodeStmt = db.prepare('UPDATE pc_devices SET short_code=? WHERE id=?');
  const setTokenStmt = db.prepare('UPDATE pc_devices SET device_token=? WHERE id=?');
  const claimStmt = db.prepare(
    'UPDATE OR IGNORE pc_devices SET client_instance_id=? WHERE id=? AND client_instance_id IS NULL',
  );
  const listUser = db.prepare('SELECT * FROM pc_devices WHERE user_id=? ORDER BY created_at ASC');
  const removeStmt = db.prepare('DELETE FROM pc_devices WHERE id=?');
  // See the interface doc comment above for why COALESCE + `IS NULL OR !=` are
  // both load-bearing rather than decorative.
  const staleOffline = db.prepare(
    `SELECT * FROM pc_devices
      WHERE is_online = 0
        AND COALESCE(last_seen_at, created_at) < ?
        AND (client_instance_id IS NULL OR client_instance_id != ?)
      ORDER BY created_at ASC`,
  );

  return {
    insert(input): PcRecord {
      ins.run(
        input.id,
        input.user_id,
        input.device_name,
        input.client_instance_id ?? null,
        input.machine_uid ?? null,
        input.device_token,
        input.room_uuid,
        input.short_code,
      );
      return toRecord(byId.get(input.id) as Record<string, unknown>);
    },
    findById(id): PcRecord | null {
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    findByToken(token): PcRecord | null {
      const r = byToken.get(token) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    listByShortCode(code): PcRecord[] {
      return (allByCode.all(code) as Record<string, unknown>[]).map(toRecord);
    },
    findByClientInstance(user_id, client_instance_id): PcRecord | null {
      const r = byInstance.get(user_id, client_instance_id) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    listByMachineUid(user_id, machine_uid): PcRecord[] {
      // An empty uid must never match — `WHERE machine_uid=''` would happily
      // collect every row some caller stamped with a blank, and merging real
      // machines is the one outcome this whole feature must not produce.
      if (!machine_uid) return [];
      return (byMachine.all(user_id, machine_uid) as Record<string, unknown>[]).map(toRecord);
    },
    listByMachineUidOtherUsers(machine_uid, except_user_id): PcRecord[] {
      // Same blank-uid refusal as above, for the same merging-machines reason —
      // and here a blank would additionally cross ACCOUNTS, which is worse.
      if (!machine_uid) return [];
      return (byMachineOther.all(machine_uid, except_user_id) as Record<string, unknown>[]).map(toRecord);
    },
    setMachineUid(id, machine_uid): void {
      setMachineStmt.run(machine_uid, id);
    },
    findByPcid(pcid): PcRecord | null {
      // An empty pcid must never match, for the same reason the uid lookup
      // above refuses one: `WHERE pcid=''` would resolve to whatever row a
      // caller once stamped blank, and here that would mean pairing a phone
      // with an arbitrary stranger's PC.
      if (!pcid) return null;
      const r = byPcid.get(pcid) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    setPcid(id, pcid): void {
      setPcidStmt.run(pcid, id);
    },
    setOnline(id, online): void {
      setOnlineStmt.run(online ? 1 : 0, new Date().toISOString(), id);
    },
    touchLastSeen(id, when): void {
      touchSeenStmt.run(when, id);
    },
    setDeviceName(id, name): void {
      setNameStmt.run(name, id);
    },
    setShortCode(id, code): void {
      setCodeStmt.run(code, id);
    },
    setToken(id, token): void {
      setTokenStmt.run(token, id);
    },
    claimClientInstance(id, value): boolean {
      return Number(claimStmt.run(value, id).changes) === 1;
    },
    adoptClientInstance(id, value): boolean {
      return Number(adoptInstanceStmt.run(value, id).changes) === 1;
    },
    listByUser(user_id): PcRecord[] {
      return (listUser.all(user_id) as Record<string, unknown>[]).map(toRecord);
    },
    remove(id): void {
      removeStmt.run(id);
    },
    listStaleOffline(cutoffIso, excludeClientInstanceId): PcRecord[] {
      return (staleOffline.all(cutoffIso, excludeClientInstanceId) as Record<string, unknown>[]).map(toRecord);
    },
  };
}
