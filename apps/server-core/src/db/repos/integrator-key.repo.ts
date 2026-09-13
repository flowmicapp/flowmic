// SPEC-REF:
//   ../schema-integrator.ts (the DDL and the whole argument for both tables)
//   ../../billing/integrator-quota.ts (the POLICY over these rows — this file
//     only stores, the same division trial-ledger.repo.ts keeps)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Card MP-1 — the store for publishable keys and for the room→key edge.

import type { DatabaseSync } from 'node:sqlite';

export interface IntegratorKeyRow {
  id: string;
  user_id: string;
  publishable_key: string;
  /** Parsed out of the stored JSON. 🔴 An unparseable value reads as `[]`, i.e.
   *  「this key may build nothing」 — the direction that costs a working key
   *  rather than an integrator's minutes. */
  origins: readonly string[];
  /** NULL ⇒ this key adds no ceiling of its own (schema-integrator.ts states
   *  why that IS the design's 「default = T's plan allowance」). */
  quota_minutes: number | null;
  used_ms: number;
  used_period: string | null;
  label: string | null;
  revoked_at: number | null;
  created_at: number;
}

export interface IntegratorKeyRepo {
  insert(input: {
    id: string;
    user_id: string;
    publishable_key: string;
    origins: readonly string[];
    quota_minutes: number | null;
    label: string | null;
    created_at: number;
  }): IntegratorKeyRow;
  /** By the `fmpk_…` string the page presented. Returns REVOKED rows too — the
   *  caller decides, because 「no such key」 and 「that key is finished」 are two
   *  facts and only the caller knows whether it wants to tell them apart. */
  findByPublishableKey(key: string): IntegratorKeyRow | null;
  findById(id: string): IntegratorKeyRow | null;
  listByUser(user_id: string): IntegratorKeyRow[];
  /** Stamps `revoked_at`. Returns false when the row does not exist or does not
   *  belong to `user_id` — ownership is checked HERE, in the same statement that
   *  writes, so a route cannot read one row and write another. Re-revoking is a
   *  no-op that still answers true: the caller asked for a state, and the state
   *  holds. */
  revoke(user_id: string, id: string, at: number): boolean;
  /**
   * Add `ms` to this key's counter for `period`, rolling it over when the stored
   * period is a different one.
   *
   * 🔴 ONE STATEMENT, NOT read-then-write. Two relay processes may settle two
   * recordings for the same key in the same millisecond; a read-modify-write
   * would lose one of them, and a sub-quota that under-counts is a ceiling that
   * does not hold. The CASE is what makes the rollover atomic with the add.
   */
  addUsage(id: string, period: string, ms: number): void;
  /** The room→key edge. */
  bindRoom(pc_device_id: string, key_id: string, created_at: number): void;
  /** Which key minted this room, or null for a room no key minted. */
  keyIdForRoom(pc_device_id: string): string | null;
}

function toRow(r: Record<string, unknown>): IntegratorKeyRow {
  let origins: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.origins ?? '[]'));
    // 🔴 EVERY ELEMENT CHECKED, not just 「is it an array」. A JSON array of
    // objects would otherwise reach the origin comparison as `[object Object]`
    // and could never match — a key that silently allows nothing, which is the
    // safe direction but an unexplainable one. Filtering here means the row's
    // own reader states what a legal element is.
    if (Array.isArray(parsed)) origins = parsed.filter((o): o is string => typeof o === 'string');
  } catch {
    origins = [];
  }
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    publishable_key: String(r.publishable_key),
    origins,
    quota_minutes: r.quota_minutes === null || r.quota_minutes === undefined ? null : Number(r.quota_minutes),
    used_ms: Number(r.used_ms ?? 0),
    used_period: (r.used_period as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    revoked_at: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    created_at: Number(r.created_at),
  };
}

export function makeIntegratorKeyRepo(db: DatabaseSync): IntegratorKeyRepo {
  const ins = db.prepare(
    `INSERT INTO integrator_keys
       (id, user_id, publishable_key, origins, quota_minutes, used_ms, used_period, label, revoked_at, created_at)
     VALUES (?,?,?,?,?,0,NULL,?,NULL,?)`,
  );
  const byKey = db.prepare('SELECT * FROM integrator_keys WHERE publishable_key=?');
  const byId = db.prepare('SELECT * FROM integrator_keys WHERE id=?');
  const byUser = db.prepare('SELECT * FROM integrator_keys WHERE user_id=? ORDER BY id ASC');
  const rev = db.prepare('UPDATE integrator_keys SET revoked_at=COALESCE(revoked_at, ?) WHERE id=? AND user_id=?');
  // The rollover and the add in one statement — see `addUsage`'s contract.
  const addUse = db.prepare(
    `UPDATE integrator_keys
        SET used_ms = CASE WHEN used_period = ? THEN used_ms + ? ELSE ? END,
            used_period = ?
      WHERE id = ?`,
  );
  const bind = db.prepare('INSERT OR REPLACE INTO integrator_rooms (pc_device_id, key_id, created_at) VALUES (?,?,?)');
  const roomKey = db.prepare('SELECT key_id FROM integrator_rooms WHERE pc_device_id=?');

  return {
    insert(input): IntegratorKeyRow {
      ins.run(
        input.id, input.user_id, input.publishable_key, JSON.stringify([...input.origins]),
        input.quota_minutes, input.label, input.created_at,
      );
      const row = byId.get(input.id) as Record<string, unknown> | undefined;
      // Read back rather than reconstructed: the row a caller gets is the row
      // the database holds, so a column default that surprises us shows up here
      // instead of in a log six weeks later.
      if (!row) throw new Error('integrator_keys: insert did not produce a row');
      return toRow(row);
    },
    findByPublishableKey(key): IntegratorKeyRow | null {
      const r = byKey.get(key) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    findById(id): IntegratorKeyRow | null {
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    listByUser(user_id): IntegratorKeyRow[] {
      return (byUser.all(user_id) as Record<string, unknown>[]).map(toRow);
    },
    revoke(user_id, id, at): boolean {
      const res = rev.run(at, id, user_id);
      return Number(res.changes ?? 0) > 0;
    },
    addUsage(id, period, ms): void {
      addUse.run(period, ms, ms, period, id);
    },
    bindRoom(pc_device_id, key_id, created_at): void {
      bind.run(pc_device_id, key_id, created_at);
    },
    keyIdForRoom(pc_device_id): string | null {
      const r = roomKey.get(pc_device_id) as { key_id?: unknown } | undefined;
      return r && typeof r.key_id === 'string' ? r.key_id : null;
    },
  };
}
