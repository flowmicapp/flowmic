// 0.2.47 — `ops_audit_log` + OpsAuditRepo (ops-action audit trail).
//
// SPEC-REF: src/db/schema.ts `-- 10. ops_audit_log` (the DDL argues every column;
//           these tests are that argument made executable)
//           src/db/repos/ops-audit.repo.ts
//
// 🔴 WHAT THIS FILE PROVES AND WHAT IT DOES NOT. It drives the repo directly
// against a real SQLite database built by the real `openDatabase` migration, so
// what is proven is the TABLE and the REPO. It proves NOTHING about production
// wiring: no route calls `append` in this round (see the repo header — unwired),
// and a green file here must never be read as "the audit trail is done".

import { describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeOpsAuditRepo } from '../src/db/repos/ops-audit.repo';

function freshDb(): DbConnection {
  return createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('ops-audit-secret-32-bytes-or-more') });
}

describe('OpsAuditRepo — who / did what / to whom / when', () => {
  it('append records all four questions and listRecent reads them back', () => {
    const db = freshDb();
    const id = db.opsAudit.append({
      actor_user_id: 'u-admin',
      action: 'billing.orphans.read',
      target_kind: 'billing_event',
      target_id: 'evt_x1',
      detail: 'read 3 orphan rows',
    });
    expect(id).toBeGreaterThan(0);
    const [row] = db.opsAudit.listRecent(10);
    expect(row).toMatchObject({
      id,
      actor_user_id: 'u-admin',
      action: 'billing.orphans.read',
      target_kind: 'billing_event',
      target_id: 'evt_x1',
      detail: 'read 3 orphan rows',
    });
    // WHEN: RFC3339, UTC, fixed width — stamped by the repo, never by the caller
    // (billing.repo.ts's header warns that a `+08:00` writer would silently
    // mis-order these columns; here there is only one writer, so it cannot).
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.close();
  });

  it('a targetless action is stored as NULL, not as an invented target', () => {
    const db = freshDb();
    db.opsAudit.append({ actor_user_id: 'u-admin', action: 'ops.dashboard.open' });
    const [row] = db.opsAudit.listRecent(10);
    expect(row).toMatchObject({ target_kind: null, target_id: null, detail: null });
    db.close();
  });

  // ── 🔴 no silent failure ────────────────────────────────────────────────────
  it('refuses a row with no actor / no action instead of writing a blank one', () => {
    const db = freshDb();
    // A blank audit row is worse than none: the table would look like it worked.
    expect(() => db.opsAudit.append({ actor_user_id: '', action: 'x.y.z' })).toThrow(/no actor/);
    expect(() => db.opsAudit.append({ actor_user_id: '   ', action: 'x.y.z' })).toThrow(/no actor/);
    expect(() => db.opsAudit.append({ actor_user_id: 'u-admin', action: '' })).toThrow(/no action/);
    expect(() => db.opsAudit.append({ actor_user_id: 'u-admin', action: '  ' })).toThrow(/no action/);
    // The POSITIVE half: the probe is not simply blind — nothing landed, and a
    // legitimate row still does.
    expect(db.opsAudit.listRecent(10)).toEqual([]);
    db.opsAudit.append({ actor_user_id: 'u-admin', action: 'x.y.z' });
    expect(db.opsAudit.listRecent(10)).toHaveLength(1);
    db.close();
  });

  // ── ORDERING: the whole reason this table has an INTEGER key ──────────────
  it('orders newest-first and breaks a same-millisecond tie by id, not by chance', () => {
    const db = freshDb();
    // A FROZEN clock: every row gets a byte-identical created_at, which is exactly
    // the case `ORDER BY created_at` alone cannot resolve. This is the assertion
    // that would go red if the key were a random TEXT id.
    const frozen = makeOpsAuditRepo(db.raw, () => Date.parse('2026-08-02T00:00:00.000Z'));
    const ids = ['a', 'b', 'c'].map((n) => frozen.append({ actor_user_id: 'u-admin', action: `ops.step.${n}` }));
    expect(ids).toEqual([...ids].sort((x, y) => x - y)); // strictly increasing
    expect(frozen.listRecent(10).map((r) => r.action)).toEqual(['ops.step.c', 'ops.step.b', 'ops.step.a']);
    expect(new Set(frozen.listRecent(10).map((r) => r.created_at)).size).toBe(1); // the tie was real
    db.close();
  });

  it('an injected clock decides created_at, and later rows sort above earlier ones', () => {
    const db = freshDb();
    let t = Date.parse('2026-08-01T00:00:00.000Z');
    const repo = makeOpsAuditRepo(db.raw, () => t);
    repo.append({ actor_user_id: 'u-admin', action: 'ops.first' });
    t += 60_000;
    repo.append({ actor_user_id: 'u-admin', action: 'ops.second' });
    expect(repo.listRecent(10).map((r) => r.action)).toEqual(['ops.second', 'ops.first']);
    expect(repo.listRecent(10)[0]!.created_at).toBe('2026-08-01T00:01:00.000Z');
    db.close();
  });

  it('limit is honoured', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) db.opsAudit.append({ actor_user_id: 'u-admin', action: `ops.n${i}` });
    expect(db.opsAudit.listRecent(2)).toHaveLength(2);
    expect(db.opsAudit.listRecent(99)).toHaveLength(5);
    db.close();
  });

  // ── APPEND-ONLY, and what that claim is actually worth ────────────────────
  it('exposes no way to change or remove a row (the interface IS the enforcement)', () => {
    const db = freshDb();
    // The DDL says append-only is enforced at the REPO SURFACE rather than by a
    // SQL trigger, and says why. That claim is checkable: the surface has exactly
    // two methods and neither mutates. If someone adds `remove`/`update`, this
    // goes red and the addition has to be argued rather than merged quietly.
    expect(Object.keys(db.opsAudit).sort()).toEqual(['append', 'listRecent']);
    // ...and the honest limit of that claim, stated as a fact rather than as
    // prose: raw SQL on the same handle CAN still delete. Nothing in the product
    // does, and a trigger would not stop whoever holds the db file either.
    db.opsAudit.append({ actor_user_id: 'u-admin', action: 'ops.will.be.deleted' });
    db.raw.exec('DELETE FROM ops_audit_log');
    expect(db.opsAudit.listRecent(10)).toEqual([]);
    // The AUTOINCREMENT half earns its keep here: the next id does NOT reuse the
    // deleted one, so the hole is visible. That is the cheap tamper signal the
    // DDL argues for, and it is the reason this table alone has an INTEGER key.
    const next = db.opsAudit.append({ actor_user_id: 'u-admin', action: 'ops.after.delete' });
    expect(next).toBeGreaterThan(1);
    db.close();
  });

  // ── NO FK on actor_user_id, on purpose ────────────────────────────────────
  it('keeps an actor’s trail after that account is deleted (why there is no FK)', () => {
    const db = freshDb();
    const user = db.users.insert({ id: 'u-doomed', email: 'doomed@b.co', display_name: 'Doomed' });
    db.opsAudit.append({ actor_user_id: user.id, action: 'user.account.delete', target_kind: 'user', target_id: 'u-other' });
    // Deleting the account is EXACTLY the case where the trail matters most. With
    // `REFERENCES users(id) ON DELETE CASCADE` this row would vanish with them —
    // an audit record you can delete by deleting yourself is not an audit record.
    db.raw.exec("DELETE FROM users WHERE id='u-doomed'");
    expect(db.users.findById('u-doomed')).toBeNull();
    const rows = db.opsAudit.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: 'u-doomed', action: 'user.account.delete' });
    db.close();
  });

  it('is reachable from the DbConnection every other repo comes from', () => {
    // Not decoration: the repo has to hang off the same connection bootstrap
    // already holds, or the wiring patch has nothing to point at.
    const db = freshDb();
    expect(typeof db.opsAudit.append).toBe('function');
    db.close();
  });
});
