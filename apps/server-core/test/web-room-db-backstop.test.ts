// card S2-04b — the DB-level backstop behind `room/web-room.ts` `ensureWebRoom`'s
// one-room-per-account rule.
//
// SPEC-REF:
//   src/room/web-room.ts (the catch around `deps.pcs.insert`, and its own
//     header's account of why `ensureWebRoom` itself carries no lock)
//   src/room/registry.ts `Registry.ensureWebRoom` (the IN-PROCESS fast path —
//     a per-account promise chain — and that method's own header on why a
//     `Promise.all` against this repo's fully-synchronous `node:sqlite` driver
//     cannot be made to DEMONSTRATE a race at all: Node drains microtasks after
//     every callback, so two calls issued from one synchronous tick against a
//     function with no internal `await` cannot interleave — call 0 runs its
//     entire read-then-insert to completion, insert included, before call 1 is
//     even invoked. `web-room-routes.test.ts`'s own race test says so and pins
//     the BEHAVIOURAL contract anyway; THIS file pins the mechanism that is
//     actually reachable with today's driver.
//   src/db/connection.ts `idx_pc_devices_web_room_owner` (the partial unique
//     index this file's reverse control drops)
//
// WHY THIS SIMULATES THE RACE RATHER THAN TIMES ONE: two READERS genuinely
// racing past `ensureWebRoom`'s `existing === null` check before either has
// written is exactly what a `WebRoomDeps.pcs.listByUser` that always reports
//「no room yet」regardless of the table's real contents would also produce for
// a second caller — and unlike real scheduling, it is deterministic. This is
// the same division of labour `admitCloudInstance`'s own comment states two
// tables up in registry.ts: "the partial unique index ... is the DB backstop;
// the find-first-then-insert here is the fast path" — a fast path that can
// legitimately lose a race is not a bug in the fast path, it is why the
// backstop exists.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService } from '../src/auth/auth-service';
import { isWebRoom } from '../src/room/registry-shared';
import { ensureWebRoom, type WebRoomDeps } from '../src/room/web-room';

const T0 = Date.parse('2026-09-08T00:00:00.000Z');

let db: DbConnection;
let userId: string;

beforeEach(async () => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  const auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from('backstop-test-secret-32-bytes-x', 'utf8'), now: () => T0 });
  const user = await auth.register({ email: 'backstop@flowmic.test', password: 'longenough1', display_name: 'T' });
  userId = user.id;
});

afterEach(() => {
  db.close();
});

/** A caller whose `listByUser` LIES EXACTLY ONCE — on the SECOND call made
 *  against it — and answers truthfully every other time.
 *
 *  That one call is the race window: it is the second `ensureWebRoom`'s own
 *  「does a room exist yet」 check, made (in the scenario this simulates) a
 *  moment before the first caller's insert has landed, so it must see the
 *  table as empty even though — by the time this synchronous test actually
 *  invokes it — the first caller has already committed. Every OTHER call is
 *  answered for real, INCLUDING the recovery read the `catch` block in
 *  web-room.ts makes after a losing insert — a real second reader's retry
 *  query, issued causally AFTER its own insert has already failed, would see
 *  the winner's row same as any other reader; only its FIRST look was stale. */
function staleReaderDeps(): WebRoomDeps {
  let codeSeq = 0;
  let listByUserCalls = 0;
  return {
    pcs: {
      listByUser: (uid) => {
        listByUserCalls += 1;
        return listByUserCalls === 2 ? [] : db.pcs.listByUser(uid);
      },
      findById: (id) => db.pcs.findById(id),
      insert: (row) => db.pcs.insert(row),
      setShortCode: (id, code) => db.pcs.setShortCode(id, code),
      setRoomExpiry: (id, stamp) => db.pcs.setRoomExpiry(id, stamp),
      remove: (id) => db.pcs.remove(id),
    },
    mobiles: { listByPc: (id) => db.mobiles.listByPc(id) },
    // Distinct per call so nothing here depends on the governor's own
    // uniqueness bookkeeping — `short_code` carries no DB-level constraint
    // (short-code.ts's governor is the ONLY thing that makes a LIVE code
    // exclusive), so two different literal strings never collide with it.
    allocateCode: () => String(1000 + (codeSeq += 1)).padStart(4, '0'),
    stampCode: () => undefined,
    codeIsActive: () => true,
    stampPcid: () => undefined,
    now: () => T0,
  };
}

describe('two readers who both observed "no room yet" leave exactly one row', () => {
  it('the SECOND insert is caught and answers with the row the FIRST one wrote', () => {
    const deps = staleReaderDeps();

    const first = ensureWebRoom(deps, userId);
    expect(first.created).toBe(true);

    // The race: this call's OWN read (via `deps.pcs.listByUser`) also came back
    // empty, exactly as it would have if it ran a moment before `first`'s
    // insert landed rather than a moment after this test's `first` call
    // returned.
    const second = ensureWebRoom(deps, userId);

    // The loser does not get its own row — it gets the winner's.
    expect(second.created).toBe(false);
    expect(second.pc.id).toBe(first.pc.id);
    expect(second.token).toBe(first.token);

    // The half neither `created` flag can prove on its own: the table itself
    // holds exactly one row for this account.
    expect(db.pcs.listByUser(userId).filter(isWebRoom)).toHaveLength(1);
  });

  it('a genuinely unrelated UNIQUE violation is NOT swallowed as "someone else won"', () => {
    // `device_token`/`room_uuid` are their OWN unique columns (schema.ts). A
    // collision there is a DIFFERENT failure than the one this catch exists
    // for — a real bug, or a `newToken()`/`randomUUID()` collision — and must
    // still surface as a throw. If it did not, a genuine defect would be
    // silently misread as "the account already has a room" and hand back a
    // room token belonging to whichever OTHER row happened to exist.
    //
    // The collision cannot be produced by chance (both are random), so it is
    // engineered directly: `insert` is swapped for one that raises the exact
    // shape SQLite raises for a DIFFERENT column than `pc_devices.user_id`.
    const deps: WebRoomDeps = {
      ...staleReaderDeps(),
      pcs: {
        ...staleReaderDeps().pcs,
        insert: () => {
          const err = new Error('UNIQUE constraint failed: pc_devices.device_token') as Error & { code: string };
          err.code = 'ERR_SQLITE_ERROR';
          throw err;
        },
      },
    };
    expect(() => ensureWebRoom(deps, userId)).toThrow(/pc_devices\.device_token/);
  });
});

// 🔴 REVERSE CONTROL, seen red (S2-04b cross-check, 2026-09): with
// `idx_pc_devices_web_room_owner` dropped, the identical simulated race above
// mints TWO rows instead of one, and `second.created` reads `true` — there is
// no constraint left to catch, so the code path in web-room.ts's `catch` block
// never runs at all. Restored immediately after by re-running
// `reconcileSchema`'s own CREATE statement, and the drop is scoped to a single
// throwaway connection/table so it cannot bleed into any other test file.
describe('🔴 reverse control — without the index, the same race mints two rows', () => {
  it('goes red exactly as described, then the fix is restored', () => {
    db.raw.exec('DROP INDEX idx_pc_devices_web_room_owner');
    const deps = staleReaderDeps();

    const first = ensureWebRoom(deps, userId);
    const second = ensureWebRoom(deps, userId);

    // THIS is the red the card asked for — two rows, and the second call
    // believes it minted its own.
    expect(second.created).toBe(true);
    expect(second.pc.id).not.toBe(first.pc.id);
    expect(db.pcs.listByUser(userId).filter(isWebRoom)).toHaveLength(2);

    // Restore: delete the duplicate the missing index just let through (a real
    // recovery would keep whichever row's token is still live — here it does
    // not matter which), THEN recreate the index, proving the schema itself
    // accepts the fix back — a `CREATE UNIQUE INDEX` over data that still
    // violated it would fail exactly the way the row insert above did not.
    db.pcs.remove(second.pc.id);
    db.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_devices_web_room_owner ON pc_devices(user_id) WHERE room_kind='web'");
    expect(db.pcs.listByUser(userId).filter(isWebRoom)).toHaveLength(1);
  });
});
