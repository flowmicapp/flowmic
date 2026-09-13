// SPEC-REF:
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//     (one lifetime 120 s per browser identity — why `findByDeviceUid`,
//     `refreshToken` and `msUsedByUser` exist)
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.3 (the
//     SUPERSEDED grant sequence), §3.1 gates 4 and 5 (the two abuse caps read here)
//   ../schema-trial.ts (the DDL, and why there is no `ms_used` column)
//   ../../billing/trial-ledger.ts (the grant arithmetic; this file only stores)
//   *** HUMAN-AUDIT SENSITIVE (schema + a paid dimension) ***
//
// The only reader and writer of `trial_ledger`. Rows in, rows out, no policy:
// how long a visitor may speak is decided in billing/trial-ledger.ts, which is
// where the sequence and its argument live.

import type { DatabaseSync } from 'node:sqlite';

export interface TrialLedgerRow {
  anon_user_id: string;
  ip_bucket: string;
  /** UTC `YYYY-MM-DD`. */
  day: string;
  /** How many grants this bucket had already spent today when the row was
   *  minted. FORENSIC ONLY since owner §10 — it no longer picks a grant. */
  grants_used: number;
  ms_granted: number;
  anon_token: string | null;
  token_expires_at: number;
  created_at: string;
  /** The `wb-…` browser identity this grant belongs to, or null for a row minted
   *  before the column existed / by a caller that declared none. */
  device_uid: string | null;
}

export interface TrialLedgerInsert {
  anon_user_id: string;
  ip_bucket: string;
  day: string;
  grants_used: number;
  ms_granted: number;
  anon_token: string;
  token_expires_at: number;
  created_at: string;
  /** Null when the caller declared no browser identity (an older web build).
   *  Such a row is NOT reusable by uid — see billing/trial-ledger.ts. */
  device_uid: string | null;
}

export interface TrialLedgerRepo {
  insert(input: TrialLedgerInsert): void;
  /** The row a live token names, or null. Expiry is NOT checked here — the
   *  caller holds the clock, and a repo that silently hid an expired row would
   *  make「no such token」and「your hour is up」the same answer. */
  findByToken(token: string): TrialLedgerRow | null;
  findByUser(anonUserId: string): TrialLedgerRow | null;
  /**
   * The identity a browser already has, or null — owner §10's whole mechanism.
   *
   * 🔴 IT LOOKS AT NO DAY AND NO BUCKET. A trial is one lifetime allowance, so a
   * uid that first appeared last week must find its own row today; filtering by
   * `day` here would silently re-open every spent trial at midnight, which is
   * exactly the behaviour the ruling replaced.
   */
  findByDeviceUid(deviceUid: string): TrialLedgerRow | null;
  /**
   * Give a returning identity a fresh credential — the HTTP demo arm's token has
   * a one-hour TTL and a lifetime trial outlives it many times over.
   *
   * 🔴 IT TOUCHES THE TOKEN AND NOTHING ELSE. `ms_granted` is written once, at
   * mint; an UPDATE that also rewrote it would be a second author for 「how much
   * was this identity given」 and the one able to hand out a second 120 s.
   */
  refreshToken(anonUserId: string, token: string, expiresAtMs: number): void;
  /**
   * Milliseconds this ONE identity has actually spent, read through the same
   * meter `msUsedOn` reads (`usage_records`) rather than a column beside
   * `ms_granted` — see schema-trial.ts for why there is no second author here.
   */
  msUsedByUser(anonUserId: string): number;
  /** How many identities this IP bucket has minted on `day`. */
  countForBucket(ipBucket: string, day: string): number;
  /** Milliseconds GRANTED site-wide on `day`. */
  msGrantedOn(day: string): number;
  /**
   * Milliseconds actually SPENT site-wide on `day`, read through the one meter
   * this server has: `usage_records`, joined to the day's anonymous identities.
   *
   * 🔴 A JOIN AND NOT A COLUMN. See schema-trial.ts: a `ms_used` column beside
   * `ms_granted` would be a second author for a number the billing meter
   * already owns, and the two would disagree the first time a session settled
   * while a mint was in flight.
   */
  msUsedOn(day: string): number;
  /**
   * How many DEMO rooms are live right now: web rooms owned by an anonymous
   * identity whose expiry has not passed.
   *
   * A JOIN rather than a counter for the reason `msUsedOn` is one: the rooms are
   * `pc_devices` rows and that table is their only author. `nowIso` is the same
   * ISO-8601 shape `pc_devices.room_expires_at` is written in, so the comparison
   * is the string comparison sqlite already does everywhere else on that column.
   */
  countLiveRooms(nowIso: string): number;
  /**
   * Identities minted before `createdBeforeIso`, oldest first — the cleanup
   * sweep's candidate list. Reading it (rather than issuing a DELETE with the
   * same WHERE) is what makes a dry run possible at all.
   *
   * 🔴 IT JOINS `users` AND REQUIRES `anonymous = 1`, even though every row in
   * this table names an anonymous identity by construction. The redundancy is
   * deliberate: the caller DELETES `users` rows, and the predicate that decides
   * which ones must be read from the column that answers it. A ledger row is
   * evidence about an identity, not the definition of one.
   */
  listOlderThan(createdBeforeIso: string, limit: number): TrialLedgerRow[];
}

function toRow(r: Record<string, unknown>): TrialLedgerRow {
  return {
    anon_user_id: r.anon_user_id as string,
    ip_bucket: r.ip_bucket as string,
    day: r.day as string,
    grants_used: Number(r.grants_used ?? 0),
    ms_granted: Number(r.ms_granted ?? 0),
    anon_token: typeof r.anon_token === 'string' ? r.anon_token : null,
    token_expires_at: Number(r.token_expires_at ?? 0),
    created_at: r.created_at as string,
    device_uid: typeof r.device_uid === 'string' ? r.device_uid : null,
  };
}

export function makeTrialLedgerRepo(db: DatabaseSync): TrialLedgerRepo {
  const ins = db.prepare(
    `INSERT INTO trial_ledger
       (anon_user_id, ip_bucket, day, grants_used, ms_granted, anon_token, token_expires_at, created_at, device_uid)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const byToken = db.prepare('SELECT * FROM trial_ledger WHERE anon_token=?');
  const byUser = db.prepare('SELECT * FROM trial_ledger WHERE anon_user_id=?');
  const byDevice = db.prepare('SELECT * FROM trial_ledger WHERE device_uid=?');
  const rotate = db.prepare('UPDATE trial_ledger SET anon_token=?, token_expires_at=? WHERE anon_user_id=?');
  const usedByUser = db.prepare(
    'SELECT COALESCE(SUM(stt_minutes),0) AS minutes FROM usage_records WHERE user_id=?',
  );
  const countBucket = db.prepare('SELECT COUNT(*) AS n FROM trial_ledger WHERE day=? AND ip_bucket=?');
  const grantedDay = db.prepare('SELECT COALESCE(SUM(ms_granted),0) AS ms FROM trial_ledger WHERE day=?');
  // `stt_minutes` is REAL minutes (db/schema.ts `-- 6. usage_records`), so the
  // conversion to ms happens here, once, rather than at each caller.
  const usedDay = db.prepare(
    `SELECT COALESCE(SUM(u.stt_minutes),0) AS minutes
       FROM trial_ledger t JOIN usage_records u ON u.user_id = t.anon_user_id
      WHERE t.day=?`,
  );
  const liveRooms = db.prepare(
    `SELECT COUNT(*) AS n FROM pc_devices p JOIN trial_ledger t ON t.anon_user_id = p.user_id
      WHERE p.room_kind = 'web' AND (p.room_expires_at IS NULL OR p.room_expires_at > ?)`,
  );
  // Ordered oldest-first so a bounded sweep always makes progress on the oldest
  // rows rather than revisiting whichever ones sqlite happened to return.
  const stale = db.prepare(
    `SELECT t.* FROM trial_ledger t JOIN users u ON u.id = t.anon_user_id
      WHERE u.anonymous = 1 AND t.created_at < ?
      ORDER BY t.created_at ASC LIMIT ?`,
  );
  return {
    insert(input): void {
      ins.run(
        input.anon_user_id, input.ip_bucket, input.day, input.grants_used,
        input.ms_granted, input.anon_token, input.token_expires_at, input.created_at,
        input.device_uid,
      );
    },
    findByToken(token): TrialLedgerRow | null {
      if (typeof token !== 'string' || token === '') return null;
      const r = byToken.get(token) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    findByUser(anonUserId): TrialLedgerRow | null {
      const r = byUser.get(anonUserId) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    findByDeviceUid(deviceUid): TrialLedgerRow | null {
      // An empty string is not an identity. Guarded here rather than trusted to
      // the index, because '' would match every OTHER caller that passed ''.
      if (typeof deviceUid !== 'string' || deviceUid === '') return null;
      const r = byDevice.get(deviceUid) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    refreshToken(anonUserId, token, expiresAtMs): void {
      rotate.run(token, expiresAtMs, anonUserId);
    },
    msUsedByUser(anonUserId): number {
      return Math.round(Number((usedByUser.get(anonUserId) as { minutes?: unknown })?.minutes ?? 0) * 60_000);
    },
    countForBucket(ipBucket, day): number {
      return Number((countBucket.get(day, ipBucket) as { n?: unknown })?.n ?? 0);
    },
    msGrantedOn(day): number {
      return Number((grantedDay.get(day) as { ms?: unknown })?.ms ?? 0);
    },
    msUsedOn(day): number {
      return Math.round(Number((usedDay.get(day) as { minutes?: unknown })?.minutes ?? 0) * 60_000);
    },
    countLiveRooms(nowIso): number {
      return Number((liveRooms.get(nowIso) as { n?: unknown })?.n ?? 0);
    },
    listOlderThan(createdBeforeIso, limit): TrialLedgerRow[] {
      return (stale.all(createdBeforeIso, limit) as Record<string, unknown>[]).map(toRow);
    },
  };
}
