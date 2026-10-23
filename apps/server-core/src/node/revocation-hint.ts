// SPEC-REF:
//   docs/strategy/2026-10-11-replication-tiering-design.md §11 (REVOKE-PUSH — the
//     gap table, the mechanism, and why it is a hint and not a row stream)
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §8-4
//     ("推送作废" — revocation must reach the replica now, not at the next pull)
//   apps/server-core/src/node/revocation-follower.ts (the replica that listens)
//   apps/server-core/src/http/node-routes.ts         (GET /api/node/revocation-hint)
//   *** HUMAN-AUDIT SENSITIVE (auth: revocation reach across nodes) ***
//
// WRITER ONLY. 「Has anything that can revoke a credential changed since you last
// asked?」 — answered as a pair `(boot, gen)` that a replica long-polls.
//
// ── WHAT IT IS, AND WHAT IT IS DELIBERATELY NOT ─────────────────────────────
//
// It is a HINT. It carries no ids and no rows: the replica's answer to it is to
// pull the whole database at once (the one import path that already exists and
// is already the authority) and then to re-check its live sockets with the
// writer. So a spurious hint costs one pull, and a missed hint costs at most the
// 30-second pull interval. Nothing here can make a replica believe something
// the writer does not.
//
// ── WHY TEMP TRIGGERS, AND NOT ONE CALL PER REVOCATION SITE ─────────────────
//
// Five of the thirteen revocation kinds in the design's table delete rows by
// CASCADE or on a timer — account deletion, PC removal, the reaper, anonymous
// cleanup, a machine re-registering under another account. A call planted at
// each revoking route would miss exactly those. A trigger cannot: sqlite fires
// row triggers for rows removed by an ON DELETE CASCADE action (measured
// 2026-10-11 on node:sqlite — deleting a `users` row fired the pairing, PC and
// user triggers). The triggers are generated from the LIVE schema at boot,
// after migrations, so a column that does not exist on this build is simply not
// watched instead of failing the CREATE.
//
// 🔴 WHY THE TRIGGER WRITES A TEMP TABLE INSTEAD OF CALLING INTO JS. The obvious
// spelling is `SELECT fm_hint()` with `db.function(...)`. That API arrived in
// Node v22.13; the production runtime on srvjp is v22.11.0 (measured
// 2026-10-11). A trigger naming a function that does not exist does not fail at
// CREATE — it fails every DELETE that fires it, i.e. it would break revocation
// itself. A temp table needs nothing from the runtime.
//
// 🔴 AND IT IS THE BETTER SPELLING ANYWAY: the temp table is written inside the
// same transaction as the delete, so a rolled-back delete rolls the counter
// back with it (measured: a JS callback fires mid-statement and cannot be
// unfired). The hint therefore never claims a revocation that did not commit.
//
// TEMP objects live in the connection's temp schema, not in the database file:
// this is not a schema change, and `VACUUM INTO` (node/snapshot.ts) does not
// carry them to any replica (measured).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** What a replica compares. `boot` changes when the writer process restarts,
 *  so 「the counter went back to 0」 can never read as 「nothing changed」. */
export interface RevocationHintState {
  boot: string;
  gen: number;
}

/** The longest a long-poll is held open. Well under every proxy timeout on the
 *  path (nginx `proxy_read_timeout` 300 s on the relay vhost, 60 s default). */
export const REVOCATION_HINT_MAX_WAIT_MS = 25_000;
/** How often the writer reads its own counter WHILE somebody is waiting. Nobody
 *  waiting ⇒ no timer at all. */
export const REVOCATION_HINT_POLL_MS = 250;
/** A replica is one machine; this is a ceiling against a misbehaving caller,
 *  not a capacity plan. Past it the request is answered at once. */
export const REVOCATION_HINT_MAX_WAITERS = 16;

/** The temp table. A name no product table will ever take: an unqualified
 *  name inside a trigger body resolves temp-first, but a clash would still be
 *  a trap for the next reader. */
const GEN_TABLE = 'flowmic_revocation_gen';

/**
 * The watch list. Each entry: a table whose DELETE revokes something, and the
 * columns whose CHANGE does. Columns are the credential itself, the owner/parent
 * it hangs off (D-25: a socket admitted under one owner must not keep running
 * under another), or a revocation stamp.
 *
 * ⚠️ What a token change buys, exactly (design §11-6 ⑥): it bumps the hint, so a
 * NEW handshake with the old token is refused on a replica within T (the pull
 * replaces the row's token). It does NOT close a socket already connected under
 * the old token: rotation keeps the row id (room/registry.ts `setToken`), the
 * sweep key is (row id, parent/owner) with no token in it, and the writer's
 * `credentialsCheckOnWriter` (node/forward-sync.ts) judges that same pair, so
 * it answers 「still held」. The writer is no different: the two `setToken` call
 * sites in room/registry.ts disconnect nothing. The old socket goes away only
 * if the new registrant joins the same room ON THE SAME NODE and displaces it
 * (socket/handlers/pc-slot-displacement.ts, mobile-room-admission.ts
 * `previous.disconnect(true)`) — a seat rule, not a credential check.
 *
 * ⚠️ NOT `last_seen_at` / `is_online` / `short_code` / `plan`: those change every
 * few seconds or are not revocations, and a hint that is always 「changed」 would
 * turn this into a 30-second pull with extra steps.
 */
export const REVOCATION_WATCH: ReadonlyArray<{ table: string; updateOf: readonly string[] }> = [
  { table: 'mobile_pairings', updateOf: ['mobile_token', 'pc_device_id', 'user_id'] },
  { table: 'pc_devices', updateOf: ['device_token', 'user_id'] },
  // ⚠️ Not the admin bit: its only in-product writer is an INSERT, and a
  // demotion is a hand-run statement on another connection, which a TEMP
  // trigger cannot see (design §11-2) — watching it would claim a reach this
  // mechanism does not have.
  { table: 'users', updateOf: ['restricted_at'] },
  { table: 'timeline_grants', updateOf: ['revoked'] },
  { table: 'integrator_keys', updateOf: ['revoked_at'] },
];

export interface RevocationHint {
  current(): RevocationHintState;
  /** Resolves with the current state as soon as it differs from `seen` (at
   *  once if it already does), or after `waitMs` with whatever it is then.
   *  `cancel` releases the wait early (the request went away). */
  waitForChange(seen: Partial<RevocationHintState>, waitMs: number): { promise: Promise<RevocationHintState>; cancel(): void };
  /** Which tables/columns are actually watched on this build. For the boot log
   *  and the tests — a watch list nobody can read is a claim, not a fact. */
  readonly watched: ReadonlyArray<{ table: string; updateOf: readonly string[] }>;
  /** Answer every waiter now and stop the timer. Shutdown calls this BEFORE the
   *  HTTP server drains, or every writer restart would wait out its grace on a
   *  replica's held request. */
  stop(): void;
}

export interface RevocationHintOptions {
  log: { info(msg: string, meta?: Record<string, unknown>): void };
  pollMs?: number;
  bootId?: string;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Install the temp table and triggers on THIS connection and return the hint.
 *  Idempotent per connection (`IF NOT EXISTS` throughout). Throws only if sqlite
 *  refuses the DDL, which the caller turns into a loud boot log rather than a
 *  boot failure — see node-runtime.ts. */
export function installRevocationHint(db: DatabaseSync, opts: RevocationHintOptions): RevocationHint {
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS ${GEN_TABLE} (k INTEGER PRIMARY KEY CHECK (k = 1), gen INTEGER NOT NULL)`,
  );
  db.exec(`INSERT OR IGNORE INTO temp.${GEN_TABLE} (k, gen) VALUES (1, 0)`);
  // Unqualified on purpose: sqlite forbids `temp.` inside a trigger body, and
  // a TEMP trigger resolves unqualified names in the temp schema first.
  const bump = `UPDATE ${GEN_TABLE} SET gen = gen + 1 WHERE k = 1;`;

  const watched: { table: string; updateOf: string[] }[] = [];
  for (const spec of REVOCATION_WATCH) {
    const cols = (db.prepare(`PRAGMA main.table_info(${quoteIdent(spec.table)})`).all() as { name: string }[])
      .map((c) => c.name);
    if (!cols.length) continue; // this build has no such table
    const t = quoteIdent(spec.table);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${quoteIdent(`flowmic_rh_${spec.table}_del`)}
      AFTER DELETE ON main.${t} BEGIN ${bump} END`);
    const present = spec.updateOf.filter((c) => cols.includes(c));
    if (present.length) {
      // `WHEN … IS NOT …` so an upsert that re-writes the same token (pc.repo's
      // ON CONFLICT DO UPDATE) is not a revocation.
      const changed = present.map((c) => `OLD.${quoteIdent(c)} IS NOT NEW.${quoteIdent(c)}`).join(' OR ');
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${quoteIdent(`flowmic_rh_${spec.table}_upd`)}
        AFTER UPDATE OF ${present.map(quoteIdent).join(', ')} ON main.${t}
        WHEN ${changed} BEGIN ${bump} END`);
    }
    watched.push({ table: spec.table, updateOf: present });
  }

  const readGen = db.prepare(`SELECT gen FROM temp.${GEN_TABLE} WHERE k = 1`);
  const boot = opts.bootId ?? randomUUID();
  const current = (): RevocationHintState => ({ boot, gen: Number((readGen.get() as { gen: number }).gen) });

  const pollMs = opts.pollMs ?? REVOCATION_HINT_POLL_MS;
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  interface Waiter { seenGen: number; settle: (s: RevocationHintState) => void }
  const waiters = new Set<Waiter>();
  let timer: unknown = null;
  let stopped = false;

  const stopTimerIfIdle = (): void => {
    if (waiters.size === 0 && timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };
  const tick = (): void => {
    const now = current();
    for (const w of [...waiters]) {
      if (now.gen !== w.seenGen) w.settle(now);
    }
  };

  opts.log.info('node.revocation_hint armed', { boot, watched });

  return {
    current,
    watched,
    waitForChange(seen, waitMs) {
      const now = current();
      const differs = seen.boot !== now.boot || seen.gen !== now.gen;
      if (stopped || differs || waitMs <= 0 || waiters.size >= REVOCATION_HINT_MAX_WAITERS) {
        return { promise: Promise.resolve(now), cancel: () => {} };
      }
      let settled = false;
      let deadline: unknown = null;
      let waiter!: Waiter;
      const promise = new Promise<RevocationHintState>((resolve) => {
        waiter = {
          seenGen: now.gen,
          settle: (s) => {
            if (settled) return;
            settled = true;
            waiters.delete(waiter);
            if (deadline !== null) clearTimeoutFn(deadline);
            stopTimerIfIdle();
            resolve(s);
          },
        };
      });
      waiters.add(waiter);
      deadline = setTimeoutFn(() => waiter.settle(current()), Math.min(waitMs, REVOCATION_HINT_MAX_WAIT_MS));
      if (typeof (deadline as { unref?: () => void })?.unref === 'function') (deadline as { unref: () => void }).unref();
      if (timer === null) {
        timer = setIntervalFn(tick, pollMs);
        if (typeof (timer as { unref?: () => void })?.unref === 'function') (timer as { unref: () => void }).unref();
      }
      return { promise, cancel: () => waiter.settle(current()) };
    },
    stop() {
      stopped = true;
      const now = current();
      for (const w of [...waiters]) w.settle(now);
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
    },
  };
}
