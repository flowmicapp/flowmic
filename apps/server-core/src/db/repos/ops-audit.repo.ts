// SPEC-REF:
//   db/schema.ts `-- 10. ops_audit_log` (the DDL and the reasoning for every
//     column — read it first; this file does not repeat it)
//   docs/rebuild/05-DATA-MODEL.md §1 (server SQLite, additive-only discipline)
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//   *** HUMAN-AUDIT SENSITIVE (DB schema + operator accountability) ***
//
// "Who did what, to whom, when" — the trail of every ops action, one line per action.
//
// ✅ WIRED (0.2.48). The 0.2.47 header here read "NOT WIRED: NOTHING IN PRODUCTION
// CALLS `append` YET … grep `opsAudit.append` outside tests: it comes back
// empty". That grep now returns exactly one file, and it is the writer shape that
// paragraph predicted: `http/ops-audit-trail.ts` `adminGate`, which wraps the
// admin gate (`http/account-auth.ts adminFromBearer`) and therefore always holds a
// PROVEN actor id. Both Bearer-gated REST surfaces go through it —
// `/api/cloud/billing/orphans` and the three `/api/ops/usage/*` routes.
//
// 🔴 THE GREP IS NOW A TEST, because a rule that says "re-check this by hand when
// you next read the file" gets re-checked once. `test/ops-audit-wiring.test.ts`
// asserts (a) `append` has a production caller, (b) bootstrap actually hands the
// repo to a route surface — import-reachable was never the question; 0.2.47 was
// import-reachable and had zero writers — and (c) no route calls the bare
// `adminFromBearer`, since a route wired to the decision alone is correctly gated
// and completely untraceable, which is worse than ungated because it looks right.
//
// ⚠️ WHAT IS STILL NOT RECORDED, so nobody reads an absence as evidence: a 401
// (unproven caller) writes NO row — `actor_user_id` is NOT NULL and means "the
// users.id already PROVEN by the Bearer", so an anonymous knock has no honest actor to name. Somebody
// hammering the ops routes with a bad token is invisible HERE and visible in the
// WARN log (`http: refused an unidentified admin caller`). Querying this table and
// finding nothing does NOT mean nobody tried.
//
// 🔴 WHAT THIS REPO DOES NOT DO. It does not decide who may write (that is the
// admin gate, one module up), it does not decide what an `action` string means,
// and it does not enforce retention. It stores, and it refuses to store a row it
// cannot make sense of. Deciding twice is how two answers drift apart.

import type { DatabaseSync } from 'node:sqlite';

/** One row of `ops_audit_log`. Field-for-field with the DDL. */
export interface OpsAuditRow {
  /** Strictly increasing, never reused — see the DDL for why this table alone
   *  uses an INTEGER key. Ordering by it is chronological BY CONSTRUCTION, which
   *  `created_at` alone cannot promise within one millisecond. */
  id: number;
  /** The `users.id` the Bearer PROVED. Never a value taken from a request body:
   *  an actor a caller can name is not an actor, it is a claim. */
  actor_user_id: string;
  /** `<domain>.<object>.<verb>`, e.g. `billing.orphans.read`. */
  action: string;
  target_kind: string | null;
  target_id: string | null;
  detail: string | null;
  /** RFC3339, UTC, fixed width — stamped here, see `append`. */
  created_at: string;
}

/** What a caller supplies. `id` and `created_at` are deliberately absent: both
 *  are facts about the write itself, and a caller that could set them could
 *  backdate its own trail. */
export interface OpsAuditInput {
  actor_user_id: string;
  action: string;
  target_kind?: string | null;
  target_id?: string | null;
  detail?: string | null;
}

export interface OpsAuditRepo {
  /**
   * Append one row. Returns its `id`.
   *
   * 🔴 There is no `update` and no `remove` on this interface, and that absence
   * IS the append-only enforcement (the DDL comment explains why it is here and
   * not in a SQL trigger). Adding either one silently converts an audit trail
   * into a mutable log, so the addition has to be argued, not typed.
   *
   * fail-loud on an unusable row: an empty `actor_user_id` or an empty `action`
   * throws rather than writing a row that records nothing. A blank audit row is
   * worse than no audit row — it makes the table look like it was working.
   */
  append(input: OpsAuditInput): number;
  /**
   * "What happened recently", newest first.
   *
   * ⚠️ It exists so the table is not write-only. A state that is true in SQLite
   * and observable nowhere is exactly the `OUTCOME_PENDING` defect that took
   * until 0.2.38 to notice (billing.repo.ts rule ④ note) — an audit trail no one can
   * read protects nobody.
   *
   * 🔴 0.3.0 D11 — **THIS PARAGRAPH USED TO SAY "NOT WIRED" AND THAT IS NOW FALSE.**
   * The 0.2.48 status was: the WRITE side is wired, this READ side has NO HTTP
   * route, its only callers are tests, so the trail is readable only by whoever
   * can open the SQLite file on the VPS. D11 closed exactly that: the route is
   * `GET /api/ops/audit/recent` (`http/ops-routes.ts` ④), admin-gated by the same
   * `adminGate` as its three siblings and refusing a non-admin BY NAME
   * (403 ADMIN_ONLY) rather than with an empty list; the bootstrap dep is
   * `ops.auditLog` (`bootstrap.ts`, a `Pick<…,'listRecent'>` slice kept separate
   * from the append-only `ops.audit` sink on purpose).
   *
   * ⚠️ Left as a correction rather than deleted, per anti-façade ④: the sentence was
   * TRUE when written and went stale because someone else's code changed. That is
   * the shape this repo keeps getting caught by, and the greppable anchors above
   * are what make the claim falsifiable next time.
   *
   * 🔴 It reads ACROSS actors by design, so any route that exposes it MUST be
   * admin-gated and must refuse BY NAME (403 ADMIN_ONLY), never with an empty
   * list — same argument as `BillingRepo.listOrphanEvents`.
   */
  listRecent(limit: number): OpsAuditRow[];
}

function toRow(r: Record<string, unknown>): OpsAuditRow {
  return {
    // node:sqlite hands INTEGER back as a number (bigint only when the connection
    // asks for it), but Number() here costs nothing and removes the question.
    id: Number(r.id),
    actor_user_id: r.actor_user_id as string,
    action: r.action as string,
    target_kind: (r.target_kind as string | null) ?? null,
    target_id: (r.target_id as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

/**
 * @param now ms-since-epoch clock. Injectable for tests; production passes
 *        nothing and gets `Date.now`.
 */
export function makeOpsAuditRepo(db: DatabaseSync, now: () => number = Date.now): OpsAuditRepo {
  // RETURNING id: the row's identity comes from the same statement that created
  // it. `last_insert_rowid()` would be a SECOND question asked of a connection
  // that other repos also write to — correct today only because node:sqlite is
  // synchronous, i.e. correct for a reason that has nothing to do with this code.
  const ins = db.prepare(
    `INSERT INTO ops_audit_log (actor_user_id, action, target_kind, target_id, detail, created_at)
     VALUES (?,?,?,?,?,?)
     RETURNING id AS id`,
  );
  const recent = db.prepare('SELECT * FROM ops_audit_log ORDER BY created_at DESC, id DESC LIMIT ?');

  return {
    append(input): number {
      // No silent failure. Both of these are unreachable from the intended writer (an
      // admin-gated route always holds a proven actor and writes a literal
      // action), so if either ever fires it is a real defect — and swallowing it
      // would leave the table looking healthy while the action went unrecorded.
      const actor = input.actor_user_id.trim();
      const action = input.action.trim();
      if (actor === '') throw new Error('ops_audit_log: refusing to append a row with no actor');
      if (action === '') throw new Error(`ops_audit_log: refusing to append a row with no action (actor=${actor})`);
      // Stamped HERE, and normalized to UTC fixed-width RFC3339 on the way in.
      // billing.repo.ts's header warns that these columns sort AS TEXT and that a
      // `+08:00` offset from one writer would silently mis-order the table; that
      // warning has to end at "the caller must be careful". Here it does not: the
      // one writer is this line, so the invariant is structural.
      const created_at = new Date(now()).toISOString();
      const res = ins.get(
        actor,
        action,
        input.target_kind ?? null,
        input.target_id ?? null,
        input.detail ?? null,
        created_at,
      ) as { id: number | bigint } | undefined;
      // An INSERT ... RETURNING always yields a row; `undefined` would mean the
      // insert did not happen, and answering with a plausible id for a row that
      // does not exist is the failure mode this whole table exists to prevent.
      if (!res) throw new Error(`ops_audit_log: append returned no row (actor=${actor} action=${action})`);
      return Number(res.id);
    },
    listRecent(limit): OpsAuditRow[] {
      return (recent.all(limit) as Record<string, unknown>[]).map(toRow);
    },
  };
}
