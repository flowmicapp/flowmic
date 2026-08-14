// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-grant-web-preview.md §3.2 (timeline_grants
//     — durable authorization rows, wrap NEVER stored, supersede-on-new-grant),
//     §2-4 (expiry/revocation judged from this table, fail-closed), §3.4 (this
//     table is the REST list/revoke data source)
//   docs/rebuild/09-WEB-SPEC.md §4 (GET/DELETE /api/timeline/grants, IDOR by
//     jwt.sub) / §5 (pull without a live grant → TIMELINE_GRANT_REQUIRED)
//   CLAUDE.md human-audit for the four sensitive path classes: pairing/auth (authorization rows) — line-by-line human review
//   *** HUMAN-AUDIT SENSITIVE (auth: web-preview authorization) ***
//
// The web-preview grant AUTHORIZATION ledger. A row says "this account allowed
// origin X to pull its blind-store timeline until expires_at」 — and nothing
// else: the wrapped master key never reaches this module (no parameter carries
// it, no column could hold it — see the DDL's argument in db/schema.ts).
//
// 🔴 EVERY method takes the user_id the caller PROVED (Bearer subject / socket
// AuthContext), and every statement filters by it. `revoke` in particular is
// IDOR-scoped in the SQL itself: a gid belonging to another account matches
// zero rows, indistinguishable from a gid that never existed — the caller
// learns "no such grant of yours" either way (no existence oracle across
// accounts, the qr-grant.ts discipline).

import type { DatabaseSync } from 'node:sqlite';

export interface TimelineGrantRow {
  gid: string;
  origin: string;
  /** ms-since-epoch. */
  expires_at: number;
  /** ms-since-epoch, stamped by the repo's injected clock. */
  created_at: number;
  revoked: boolean;
}

export interface CreateGrantInput {
  gid: string;
  user_id: string;
  origin: string;
  /** ms-since-epoch. Sanity (future, bounded) is the HANDLER's job — the repo
   *  stores what admission decided, it does not re-decide it. */
  expires_at: number;
}

export interface TimelineGrantsRepo {
  /**
   * Insert a new grant row, SUPERSEDING every currently-live row of the same
   * account first (design §3.2: "the old row is never reused; a new grant lands
   * on a new row, and the old row is marked superseded/revoked"). Superseded rows are marked revoked=1 in place — the
   * history stays visible on the REST list rather than being deleted.
   *
   * One live grant per account, by construction: the only writer of a live row
   * is this method, and its first statement retires the previous one.
   * `liveGrantFor` still guards with ORDER BY as defence in depth, not as a
   * second policy.
   *
   * Throws on a duplicate gid (PRIMARY KEY) — gids are web-minted uuids, so a
   * collision is a caller bug or a replay, and silently reusing the row would
   * let a replayed grant frame resurrect an authorization the user already
   * superseded.
   */
  create(input: CreateGrantInput): TimelineGrantRow;
  /**
   * The account's currently-live grant: not revoked AND expires_at strictly
   * after `nowMs`. Null otherwise — and null is the fail-closed answer the
   * pull gate turns into TIMELINE_GRANT_REQUIRED. Expiry is judged HERE, on
   * every call, against the caller's clock: a grant does not need a sweeper to
   * die, it stops matching.
   */
  liveGrantFor(user_id: string, nowMs: number): TimelineGrantRow | null;
  /** Every grant row of this account, newest first — the REST list projection
   *  (gid/origin/expires_at/created_at/revoked; user_id implied by the ask). */
  listFor(user_id: string): TimelineGrantRow[];
  /**
   * Mark ONE grant revoked, scoped to the proven owner. Returns true iff a row
   * of THIS account transitioned live→revoked just now; false covers "no such
   * gid", "someone else's gid" and "already revoked" alike — across
   * ACCOUNTS those are one indistinguishable outcome (no existence oracle);
   * within the caller's own account the route disambiguates via `listFor`,
   * which the owner may read anyway. Revocation is effective on the next
   * `liveGrantFor` call (i.e. the next web pull), nothing to sweep.
   */
  revoke(gid: string, user_id: string): boolean;
}

function toRow(r: Record<string, unknown>): TimelineGrantRow {
  return {
    gid: r.gid as string,
    origin: r.origin as string,
    expires_at: Number(r.expires_at),
    created_at: Number(r.created_at),
    revoked: Number(r.revoked) === 1,
  };
}

export function makeTimelineGrantsRepo(db: DatabaseSync, now: () => number = Date.now): TimelineGrantsRepo {
  const supersedeStmt = db.prepare(
    'UPDATE timeline_grants SET revoked=1 WHERE user_id=? AND revoked=0',
  );
  const insertStmt = db.prepare(
    'INSERT INTO timeline_grants (gid, user_id, origin, expires_at, created_at, revoked) VALUES (?,?,?,?,?,0)',
  );
  // ORDER BY + LIMIT even though create() keeps at most one row live: if two
  // live rows ever exist (a bug), the NEWEST wins deterministically instead of
  // whichever the scan met first.
  const liveStmt = db.prepare(
    `SELECT gid, origin, expires_at, created_at, revoked FROM timeline_grants
      WHERE user_id=? AND revoked=0 AND expires_at>?
      ORDER BY created_at DESC, gid DESC LIMIT 1`,
  );
  const listStmt = db.prepare(
    `SELECT gid, origin, expires_at, created_at, revoked FROM timeline_grants
      WHERE user_id=? ORDER BY created_at DESC, gid DESC`,
  );
  // `revoked=0` in the WHERE: `changes` then answers "did a LIVE grant die by
  // this call" rather than "did the WHERE match anything" — an UPDATE that
  // re-sets revoked=1 on an already-revoked row still counts as a change in
  // SQLite, which would make the return value a lie about work.
  const revokeStmt = db.prepare(
    'UPDATE timeline_grants SET revoked=1 WHERE gid=? AND user_id=? AND revoked=0',
  );

  return {
    create(input): TimelineGrantRow {
      const created_at = now();
      // Supersede-then-insert. Single-process synchronous node:sqlite — nothing
      // interleaves between the two statements (same argument as
      // timeline-keymeta.repo.ts putFirstWriter).
      supersedeStmt.run(input.user_id);
      insertStmt.run(input.gid, input.user_id, input.origin, input.expires_at, created_at);
      return { gid: input.gid, origin: input.origin, expires_at: input.expires_at, created_at, revoked: false };
    },
    liveGrantFor(user_id, nowMs): TimelineGrantRow | null {
      const r = liveStmt.get(user_id, nowMs) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    listFor(user_id): TimelineGrantRow[] {
      return (listStmt.all(user_id) as Record<string, unknown>[]).map(toRow);
    },
    revoke(gid, user_id): boolean {
      return Number(revokeStmt.run(gid, user_id).changes) > 0;
    },
  };
}
