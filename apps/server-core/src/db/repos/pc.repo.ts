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
  /** 2026-08-29 multi-node — which relay node this PC is registered on
   *  (`srvny` / `srvjp`). NULL means 「single-node deployment, or a row that has
   *  not registered since the column landed」, and BOTH callers must read that
   *  as 「dial the host you already have」 rather than as an error: a phone that
   *  treated NULL as 「PC is nowhere」 would break every existing pairing on the
   *  day multi-node ships. See design §4-2. */
  home_node: string | null;
  /** card S2-01 — 'app' | 'web', or NULL for a row that predates the column.
   *  🔴 NULL IS NOT 'app' AT THIS LAYER. The default lives in the protocol
   *  package ({@link clientOriginOf}) so exactly one place applies it; a repo
   *  that helpfully returned 'app' here would be a second author of the same
   *  default, and this repo's headline bug shape is a value with two authors. */
  client: string | null;
  /** card S2-01 — the far end's own version string. DIAGNOSTIC ONLY: nothing may
   *  branch on it (it is a claim the client makes about itself). */
  client_version: string | null;
  /** card S2-01 — the JSON the target declared about what it can receive
   *  (`{"image":true}`). NULL means UNDECLARED, which is the third state and the
   *  common one — see schema.ts and TargetCapsSchema for why it must not be
   *  folded into `{image:false}`. Parsed by the ONE reader
   *  (room/target-caps.ts), never here: a repo that parsed it would
   *  have to decide what a malformed value means, and that is a wire decision. */
  target_caps: string | null;
  /** card S2-04 — 'web' when `POST /api/web/rooms` minted this row for a browser
   *  target, NULL for every ordinary PC row. SERVER-MINTED: no client frame can
   *  reach this column, which is what makes it safe for `isRealPc` to spend a
   *  paid PC slot on the answer. See schema.ts for the full argument. */
  room_kind: string | null;
  /** card S2-04 — when this web room stops being worth keeping, as an ISO-8601
   *  UTC string (the spelling `setOnline` writes into `last_seen_at`, not the
   *  space-separated form SQLite defaults `created_at` to). NULL = nothing expires.
   *  Read it with db/utc-stamp.ts `parseUtcStamp`. ⚠️ Only ONE surface acts on
   *  it today (`POST /api/web/rooms` replacing an expired room); schema.ts says
   *  what that leaves open. */
  room_expires_at: string | null;
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
  client?: string | null;
  client_version?: string | null;
  target_caps?: string | null;
  /** card S2-04 — 'web' for a browser room. Absent/NULL for everything else,
   *  and there is exactly one caller that may pass it: `Registry.ensureWebRoom`. */
  room_kind?: string | null;
  /** card S2-04 — the web room's TTL stamp. Absent/NULL means nothing expires. */
  room_expires_at?: string | null;
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
  /** 2026-08-29 multi-node — stamp which node this PC just registered on.
   *  Unconditional, like setMachineUid and unlike claimClientInstance: the PC
   *  chose the node and is the authority on it, so this must CORRECT a stale
   *  value and not merely fill a NULL. A PC that moved from srvny to srvjp and
   *  left the old value behind would send its phone to the wrong node — the one
   *  failure this column exists to prevent. */
  setHomeNode(id: string, home_node: string): void;
  /** card S2-04 — push a web room's TTL out to `stamp` (an ISO-8601 UTC string;
   *  `db/utc-stamp.ts` `parseUtcStamp` is the only sanctioned reader).
   *
   *  🔴 IT ONLY EVER EXTENDS, and the reason belongs at the CALLER, not here:
   *  this is the storage verb with no policy in it (`setDeviceName`'s shape).
   *  The one caller is `Registry.ensureWebRoom`, which calls it when the account
   *  asks for its room again — evidence the page is still there. Nothing shortens
   *  a TTL, because 「the page went away」 is not something this server ever
   *  observes: a browser tab closing produces a socket disconnect that is
   *  indistinguishable from a tunnel dropping. */
  setRoomExpiry(id: string, stamp: string): void;
  /** Stamp the machine uid. Unconditional — unlike `claimClientInstance` this
   *  fills NULLs AND corrects a stale value, because the uid is derived from
   *  the hardware and the client is the authority on it. */
  setMachineUid(id: string, machine_uid: string): void;
  /** card S2-01 — write what the end holding this row just said about itself:
   *  which kind of client it is, its version, and what it can receive (JSON, or
   *  null for「it did not say」).
   *
   *  🔴 UNCONDITIONAL AND ALL THREE AT ONCE, like `setHomeNode` and unlike
   *  `claimClientInstance`. The client is the authority on itself, so this must
   *  CORRECT a stale value: a machine that was the app yesterday and a browser
   *  today (the same account, the same row) would otherwise keep declaring
   *  capabilities its current occupant does not have. And writing only the
   *  fields that are present would leave a row mixing two connections'
   *  declarations — see setClientDeclStmt. */
  setClientDeclaration(
    id: string,
    decl: { client: string | null; client_version: string | null; target_caps: string | null },
  ): void;
  /**
   * 2026-08-31 multi-node — write a WHOLE row that came from the writer, on a
   * replica, keyed on the primary key. The only caller is the handshake
   * read-through (node/token-read-through.ts); ordinary code paths must keep
   * using the narrow setters above, which each say what they are changing.
   *
   * 🔴 IT IS NOT `INSERT OR REPLACE`, AND THAT IS LOAD-BEARING. SQLite's REPLACE
   * conflict resolution DELETES the conflicting row before inserting, and with
   * `PRAGMA foreign_keys = ON` (schema.ts) a delete here fires
   * `mobile_pairings.pc_device_id REFERENCES pc_devices(id) ON DELETE CASCADE`.
   * So the「obvious」spelling of this method would silently destroy every phone
   * pairing a PC has, every time a token was read through — a data loss with no
   * error and no log. `ON CONFLICT(id) DO UPDATE` never deletes anything.
   *
   * ⚠️ It can still THROW: `device_token` and `room_uuid` are UNIQUE and `pcid`
   * has a partial unique index, so a stale local row holding one of those values
   * under a DIFFERENT id makes this a constraint violation. The caller must
   * treat that as「could not land the row」and fall back to refusing, never
   * swallow it — a half-applied identity is worse than a slow one.
   */
  upsertReplicated(row: PcRecord): void;
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
   * `listByUser(...).filter(occupiesPcSlot)`, recomputed fresh on every call — there
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
  /**
   * Card MP-11 / gap G-5 — every row of one `room_kind`, newest-agnostic, with
   * NO expiry filter.
   *
   * 🔴 THE EXPIRY IS DELIBERATELY NOT IN THE SQL, and that is the whole reason
   * this method is shaped the way it is. `room_expires_at` may be read in
   * exactly one way — `db/utc-stamp.ts` `parseUtcStamp` — because a bare parse
   * of a stamped column answers differently on two machines (that file carries
   * the measurement). A `WHERE room_expires_at <= ?` here would be a SECOND
   * reader of that column, written in a different language, free to disagree
   * with the first the day anything ever writes the bare SQLite form into it.
   * The caller filters, with the sanctioned parser, on rows this returns.
   *
   * Browser-minted room kinds only, in practice: they are the short-lived ones
   * and there are few of them alive at any instant. A caller that wants an
   * account's computers wants `listByUser`.
   */
  listByRoomKind(room_kind: string): PcRecord[];
}

function toRecord(r: Record<string, unknown>): PcRecord {
  return {
    id: r.id as string,
    user_id: r.user_id as string,
    device_name: r.device_name as string,
    client_instance_id: (r.client_instance_id as string | null) ?? null,
    machine_uid: (r.machine_uid as string | null) ?? null,
    pcid: (r.pcid as string | null) ?? null,
    home_node: (r.home_node as string | null) ?? null,
    client: (r.client as string | null) ?? null,
    client_version: (r.client_version as string | null) ?? null,
    target_caps: (r.target_caps as string | null) ?? null,
    room_kind: (r.room_kind as string | null) ?? null,
    room_expires_at: (r.room_expires_at as string | null) ?? null,
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
    `INSERT INTO pc_devices (id, user_id, device_name, client_instance_id, machine_uid, client, client_version, target_caps, room_kind, room_expires_at, device_token, room_uuid, short_code, is_online, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)`,
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
  // See `PcRepo.upsertReplicated` for why this is ON CONFLICT DO UPDATE and not
  // INSERT OR REPLACE (REPLACE would cascade-delete this PC's pairings).
  const upsertStmt = db.prepare(
    `INSERT INTO pc_devices
       (id, user_id, device_name, client_instance_id, machine_uid, pcid, home_node,
        client, client_version, target_caps, room_kind, room_expires_at,
        device_token, room_uuid, short_code, is_online, last_seen_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       user_id=excluded.user_id,
       device_name=excluded.device_name,
       client_instance_id=excluded.client_instance_id,
       machine_uid=excluded.machine_uid,
       pcid=excluded.pcid,
       home_node=excluded.home_node,
       client=excluded.client,
       client_version=excluded.client_version,
       target_caps=excluded.target_caps,
       room_kind=excluded.room_kind,
       room_expires_at=excluded.room_expires_at,
       device_token=excluded.device_token,
       room_uuid=excluded.room_uuid,
       short_code=excluded.short_code,
       is_online=excluded.is_online,
       last_seen_at=excluded.last_seen_at,
       created_at=excluded.created_at`,
  );
  const byMachineOther = db.prepare(
    'SELECT * FROM pc_devices WHERE machine_uid=? AND user_id<>? ORDER BY created_at DESC, rowid DESC',
  );
  const byPcid = db.prepare('SELECT * FROM pc_devices WHERE pcid=?');
  const setPcidStmt = db.prepare('UPDATE pc_devices SET pcid=? WHERE id=?');
  const setHomeNodeStmt = db.prepare('UPDATE pc_devices SET home_node=? WHERE id=?');
  const setRoomExpiryStmt = db.prepare('UPDATE pc_devices SET room_expires_at=? WHERE id=?');
  // card S2-01 — ONE statement for all three, because they are ONE declaration
  // made in ONE frame. Splitting them would let a row end up claiming
  // 「I am a web client」 from this connection and 「I can take images」 from a
  // previous one, and a capability read off two different frames is a capability
  // nobody declared.
  const setClientDeclStmt = db.prepare(
    'UPDATE pc_devices SET client=?, client_version=?, target_caps=? WHERE id=?',
  );
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
  // card MP-11 / gap G-5 — no expiry predicate here ON PURPOSE; see the
  // interface doc for why `room_expires_at` has exactly one reader.
  const byRoomKind = db.prepare('SELECT * FROM pc_devices WHERE room_kind=? ORDER BY created_at ASC');

  return {
    insert(input): PcRecord {
      ins.run(
        input.id,
        input.user_id,
        input.device_name,
        input.client_instance_id ?? null,
        input.machine_uid ?? null,
        input.client ?? null,
        input.client_version ?? null,
        input.target_caps ?? null,
        input.room_kind ?? null,
        input.room_expires_at ?? null,
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
    setClientDeclaration(id, decl): void {
      setClientDeclStmt.run(decl.client, decl.client_version, decl.target_caps, id);
    },
    upsertReplicated(row): void {
      upsertStmt.run(
        row.id,
        row.user_id,
        row.device_name,
        row.client_instance_id,
        row.machine_uid,
        row.pcid,
        row.home_node,
        row.client,
        row.client_version,
        row.target_caps,
        row.room_kind,
        row.room_expires_at,
        row.device_token,
        row.room_uuid,
        row.short_code,
        row.is_online,
        row.last_seen_at,
        row.created_at,
      );
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
    setRoomExpiry(id, stamp): void {
      setRoomExpiryStmt.run(stamp, id);
    },
    setHomeNode(id, home_node): void {
      setHomeNodeStmt.run(home_node, id);
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
    listByRoomKind(room_kind): PcRecord[] {
      return (byRoomKind.all(room_kind) as Record<string, unknown>[]).map(toRecord);
    },
  };
}
