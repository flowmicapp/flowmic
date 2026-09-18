// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §17
//     (NR-30 — the entry this file measures, and the dated block recording it)
//   src/node/token-rows.ts            (what a read-through carries, and what it does not)
//   src/node/replica-puller.ts        (PULL_INTERVAL_MS — the width of the window)
//   src/node/authoritative-quota.ts   (the residue this shares an account with)
//   src/billing/trial-ledger.ts       (TRIAL_LIFETIME_GRANT_MS — the number)
//   src/auth/web-trial-identity.ts    (who may mint, and for which room kind)
//
// ── WHAT NR-30 SAYS, AND WHAT THIS FILE MEASURES ────────────────────────────
//
// The ledger entry reads: 「right after a trial ledger row is minted, a replica
// can read 0 seconds for up to one 30 s sync period, which biases toward
// REFUSING」. That sentence had never been driven. Card J4 asked for a number
// before a fix, so this file establishes three things a reader can check:
//
//   ① THE WINDOW IS REAL AND ITS VALUE IS 0. A trial identity minted on the
//      writer, reached on a replica through the production read-through, is
//      worth 0 ms there — `ensureQuota` refuses with QUOTA_EXCEEDED — while the
//      same identity is worth TRIAL_LIFETIME_GRANT_MS on the writer.
//      CAUSE, asserted rather than asserted-about: `applyTokenResolution` lands
//      `users` + `pc_devices` + `mobile_pairings` and NOTHING ELSE, so the
//      anonymous account exists on the replica while its grant does not.
//   ② IT CLOSES AT THE PULL. One replication cycle later the same read is 120 s.
//      The window's width is therefore PULL_INTERVAL_MS and not something longer.
//   ③ THE ONLY OTHER DIRECTION THIS SEAM COULD HAVE, AND WHY IT IS NOT
//      REACHABLE. `BillingService.effectiveLimits` enters its anonymous branch
//      on `users.anonymous`, so a trial id that arrived WITHOUT its `users` row
//      would be answered `planLimits('free')` — TWENTY minutes, ten times the
//      trial, to a visitor who proved nothing. That is the opposite of the
//      ledger's 「biases toward refusing」, so it was worth asking how far away
//      it is.
//      🔴 I EXPECTED 「one deleted argument away」 AND THE MEASUREMENT SAID NO
//      (reverse control below): deleting `mobile.trial_user_id` from
//      `ownersOf(...)` in token-rows.ts does not produce an over-grant, it
//      produces `FOREIGN KEY constraint failed` inside `applyTokenResolution` —
//      `mobile_pairings.trial_user_id REFERENCES users(id)`, so a pairing row
//      whose trial account did not travel CANNOT BE LANDED, and the read-through
//      refuses instead. The over-grant is fail-closed twice over; the case below
//      has to FORGE the state with a raw DELETE to observe the number at all.
//
// ── 🔴 REVERSE CONTROL, MEASURED RED (2026-09-15, card J4) ─────────────────
// Marker `REVERSE-CONTROL-J4`: `src/node/token-rows.ts:125` reduced to
// `ownersOf(repos, owner.user_id, mobile.user_id)` — i.e. the trial identity's
// account no longer travels with the pairing.
//   RED, 3 of 8 cases, all with the same verbatim failure:
//   `Error: FOREIGN KEY constraint failed` (src/node/token-rows.ts
//   applyTokenResolution ← test `readThroughOntoReplica`).
// ⚠️ WORTH READING TWICE: it went red through the DATABASE and not through a
// wrong number, which is what turned claim ③ above from an assumption into a
// measured one. Restored; `grep -rn REVERSE-CONTROL-J4 apps/server-core/src` = 0,
// `git diff` on the production tree empty, all 8 cases green again.
//
// ── AND HOW OFTEN A REAL VISITOR LANDS IN IT: the reachability chain ────────
//
// The frequency is not a rate, it is a conjunction, and three of its links are
// pinned below because each is a thing someone could change without meaning to:
//
//   · ONLY A DEMO ROOM MINTS (`webTrialDecision`, roomKind !== 'demo' ⇒ none),
//     so no pairing to a real desktop and no integrator room is exposed at all;
//   · ONLY A WRITER MINTS (`mayMint: false` ⇒ none; `mobile:pair` is in the
//     writer-only set), so the row is always born on the writer;
//   · A DEMO VISITOR CANNOT BE DIALLING A REPLICA, because the `endpoint` their
//     microphone dials is built by `relayWsOrigin(req)` inside the SAME request
//     that mints the room (http/web-room-routes.ts), and that request is a POST
//     to `/api/web/rooms` — which a replica answers 421 NODE_IS_REPLICA, never a
//     room. The browser is not a node-selecting client: `packages/core`'s
//     `node-list.ts` offers `resolveNodeUrl(nodes, nodeId)` — an id turned into
//     an address, never a node chosen by latency — and the session only follows
//     a `home_node` an ack disagrees with. The demo's own page dials
//     `ticket.endpoint` (island/driver.ts), the very value that mint response
//     produced, so both ends of a demo sit on the writer.
//
// ⇒ THE MEASURED EXPOSURE IS ZERO SESSIONS, not a small rate: there is no path
//   today that puts a demo pairing's token on a replica within a pull period of
//   its mint. NOT closed, therefore, and the reason is written down in §17 of
//   the ledger rather than in a fix: closing it means teaching the read-through
//   to carry a billing row, which is a sensitive surface, and it would trade a
//   fail-CLOSED answer on a paid dimension for the same eventually-consistent
//   first read every other principal already has (authoritative-quota.ts's own
//   「the FIRST read for a user on a replica has no cell yet」 residue).
//
// ⚠️ WHAT THIS FILE IS NOT. It does not drive the node HTTP transport — the
// wire contract for `/api/node/resolve-token` is pinned by
// cross-node-token-read-through.test.ts and is not re-proved here; this file
// drives `resolveTokenRows` → `applyTokenResolution`, the same pair that
// handler calls. And it measures no production frequency: nobody here can read
// production, so the zero above is derived from code paths, not from a counter.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { Registry } from '../src/room/registry';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard, type QuotaGuard } from '../src/billing/quota-guard';
import { makeTrialLedger, TRIAL_LIFETIME_GRANT_MS } from '../src/billing/trial-ledger';
import { makeWebTrialIdentities, webTrialDecision } from '../src/auth/web-trial-identity';
import { resolveTokenRows, applyTokenResolution } from '../src/node/token-rows';
import { PULL_INTERVAL_MS } from '../src/node/replica-puller';
import { planLimits } from '../src/billing/plans';
import { makeHttpHandler } from '../src/http/router';

const NOW = Date.UTC(2026, 8, 15, 9, 0, 0);
const IP_SALT = 'trial-ip-salt-for-this-file-only';
const WRITER_URL = 'https://srvny.flowmic.app';

interface Node {
  db: DbConnection;
  registry: Registry;
  billing: BillingService;
  quota: QuotaGuard;
}

function makeNode(): Node {
  const db = createDbConnection({
    dbPath: ':memory:',
    encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
  });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  const billing = new BillingService({
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    billing: db.billing,
    // The SAME reader production wires (bootstrap.ts `makeTrialLedger`). A stub
    // here would make every number below a property of the stub.
    trials: makeTrialLedger({ rows: db.trials, users: db.users }),
    unlockAll: false,
    now: () => NOW,
  });
  return {
    db,
    registry: new Registry({ pcs: db.pcs, mobiles: db.mobiles }),
    billing,
    quota: makeQuotaGuard(db.usage, billing, { mode: 'saas', now: () => NOW }),
  };
}

let writer: Node;
let replica: Node;

beforeEach(() => {
  writer = makeNode();
  replica = makeNode();
});
afterEach(() => {
  writer.db.close();
  replica.db.close();
});

/**
 * A demo room's web pairing, minted on the writer, with its trial identity —
 * the production sequence (`registry.pairMobile` then `WebTrialIdentities`),
 * not a hand-built row.
 *
 * Returns the mobile token (what a browser presents to whichever node it dials)
 * and the anonymous user id the seconds come off.
 */
function demoPairingOnWriter(): { token: string; anonId: string; pcId: string } {
  const { pc } = writer.registry.registerPc({ device_name: 'FlowMic Web', user_id: 'default' });
  const { token, mobile } = writer.registry.pairMobile({
    short_code: pc.short_code,
    mobile_name: 'Browser',
    device_uid: 'wb-visitor-1',
    client: 'web',
  });
  let n = 0;
  const trials = makeWebTrialIdentities({
    trials: makeTrialLedger({ rows: writer.db.trials, users: writer.db.users }),
    mobiles: writer.db.mobiles,
    ipSalt: IP_SALT,
    tokenTtlMs: 60 * 60 * 1000,
    newId: () => `anon-${(n += 1)}`,
    newToken: () => `fm_${n}`,
    now: () => NOW,
  });
  const anonId = trials.resolve({
    client: 'web',
    roomKind: 'demo',
    account: null,
    mobile: { id: mobile.id, trial_user_id: null, device_uid: 'wb-visitor-1' },
    ip: '203.0.113.9',
    // The writer. This is the only value production ever reaches a mint with —
    // see the reachability case below.
    mayMint: true,
  });
  expect(anonId).not.toBeNull();
  return { token, anonId: anonId!, pcId: pc.id };
}

/** The production read-through, minus its transport: the same two functions the
 *  `/api/node/resolve-token` handler calls on each side of the wire. */
function readThroughOntoReplica(token: string): void {
  const rows = resolveTokenRows(writer.db, token);
  expect(rows).not.toBeNull();
  applyTokenResolution(replica.db, rows!);
}

describe('NR-30 — a freshly minted trial identity, read on a replica', () => {
  it('the control: on the WRITER the identity is worth the full lifetime grant', () => {
    const { anonId } = demoPairingOnWriter();

    expect(writer.billing.effectiveLimits(anonId).stt_minutes)
      .toBe(TRIAL_LIFETIME_GRANT_MS / 60_000);
    expect(writer.quota.remainingSttMs(anonId)).toBe(TRIAL_LIFETIME_GRANT_MS);
    expect(() => writer.quota.ensureQuota(anonId, 'stt')).not.toThrow();
  });

  it('🔴 THE WINDOW, MEASURED: on the replica the same identity is worth 0 ms', () => {
    const { token, anonId } = demoPairingOnWriter();

    readThroughOntoReplica(token);

    // The cause, named on the row rather than inferred from the number: the
    // account landed, the grant did not.
    expect(replica.db.users.findById(anonId)?.anonymous).toBe(true);
    expect(replica.db.trials.findByUser(anonId)).toBeNull();

    expect(replica.billing.effectiveLimits(anonId).stt_minutes).toBe(0);
    expect(replica.quota.remainingSttMs(anonId)).toBe(0);
    // And the shape a visitor would meet: `ServerError('QUOTA_EXCEEDED')`, whose
    // diagnostic reads `used 0/0` — 「your two minutes are up」 to somebody who
    // has not spoken a word, which is why the exposure below is worth deriving
    // rather than waving at.
    let thrown: unknown = null;
    try {
      replica.quota.ensureQuota(anonId, 'stt');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string } | null)?.code).toBe('QUOTA_EXCEEDED');
    expect((thrown as Error).message).toBe('stt quota exceeded (used 0/0)');
  });

  it('② it closes at the next pull — the width is PULL_INTERVAL_MS, nothing longer', () => {
    const { token, anonId } = demoPairingOnWriter();
    readThroughOntoReplica(token);
    expect(replica.quota.remainingSttMs(anonId)).toBe(0);

    // What the 30-second pull does to this table, in one line: the writer's copy
    // replaces the replica's. (replica-puller.ts does it for every table inside
    // one transaction; the row is what matters here, not the mechanism, which
    // replica-replication.test.ts owns.)
    replica.db.trials.insert({ ...writer.db.trials.findByUser(anonId)!, anon_token: 'fm_1' });

    expect(replica.quota.remainingSttMs(anonId)).toBe(TRIAL_LIFETIME_GRANT_MS);
    expect(PULL_INTERVAL_MS).toBe(30_000);
  });

  it('③ the other direction this seam could have — and it has to be FORGED to see it', () => {
    const { token, anonId } = demoPairingOnWriter();
    readThroughOntoReplica(token);

    // A raw DELETE, because nothing in the system produces this state: the
    // read-through cannot land a pairing without its trial account (FOREIGN KEY,
    // the reverse control in this file's header) and a sweep that removes the
    // account empties the reference instead (ON DELETE SET NULL, the case below).
    replica.db.raw.exec(`DELETE FROM users WHERE id = '${anonId}'`);

    expect(replica.billing.effectiveLimits(anonId).stt_minutes)
      .toBe(planLimits('free').stt_minutes);
    expect(replica.quota.remainingSttMs(anonId))
      .toBe(planLimits('free').stt_minutes * 60_000);
    // Ten times the trial, to an identity nobody authenticated — the number is
    // here so that anyone tempted to make `effectiveLimits` 「fall back to a
    // tier」 for an unknown id can read what that fallback is worth.
    expect(planLimits('free').stt_minutes * 60_000).toBeGreaterThan(TRIAL_LIFETIME_GRANT_MS);
  });

  it('🔴 …and the state the previous case had to FORGE cannot arise on its own', () => {
    // The case above deletes a row the database will not let a caller orphan.
    // `mobile_pairings.trial_user_id REFERENCES users(id) ON DELETE SET NULL`
    // means a swept identity takes the reference with it, so 「a pairing naming
    // an account that is not here」 is unrepresentable — on either node, since
    // the replica's copy carries the same constraint. That is the SECOND
    // mechanism holding the refusal direction, and it is worth knowing that the
    // over-grant above needs both of them removed, not one.
    const { token, anonId } = demoPairingOnWriter();
    const pairingId = writer.db.mobiles.findByToken(token)!.id;
    expect(writer.db.mobiles.findByToken(token)!.trial_user_id).toBe(anonId);

    writer.db.raw.exec(`DELETE FROM users WHERE id = '${anonId}'`);

    expect(writer.db.mobiles.findById(pairingId)!.trial_user_id).toBeNull();
    // And re-pointing it by hand is refused rather than silently stored.
    expect(() => writer.db.mobiles.setTrialUser(pairingId, anonId))
      .toThrowError(/FOREIGN KEY/);
  });
});

describe('NR-30 — the reachability chain, pinned so it cannot change quietly', () => {
  const base = {
    client: 'web',
    account: null,
    trialUserId: null,
    mayMint: true,
  } as const;

  it('only a DEMO room mints a trial at all', () => {
    expect(webTrialDecision({ ...base, roomKind: 'demo' })).toEqual({ kind: 'mint' });
    // Every OTHER member of ROOM_KINDS, plus the unreadable one. `'web'` is in
    // here deliberately and is not a typo: a site-demo room is STORED as
    // `room_kind:'web'` (metering-principal.ts — `'demo'` is derived from
    // `users.anonymous`, never stored), so a signed-in visitor's browser room
    // and a demo room are the same column value and only the derived kind
    // separates them.
    for (const roomKind of ['app', 'web', 'integrator', null] as const) {
      expect(webTrialDecision({ ...base, roomKind })).toEqual({ kind: 'none' });
    }
  });

  it('only a WRITER mints one — a replica returns none rather than a row it will lose', () => {
    expect(webTrialDecision({ ...base, roomKind: 'demo', mayMint: false }))
      .toEqual({ kind: 'none' });
  });

  it('🔴 and a replica cannot hand out a demo room, so it cannot be the endpoint one dials', () => {
    // `web-room-routes.ts` builds the `endpoint` a visitor's microphone dials
    // with `relayWsOrigin(req)` — the host of THIS request. So whichever node
    // answers the mint is the node the whole demo session talks to, and a
    // replica answers it with the writer's address instead of a room.
    const handler = makeHttpHandler({
      config: { mode: 'saas' },
      billing: {},
      version: '0.0.0',
      nodes: { nodeId: 'srvjp', version: '0.0.0', writerUrl: WRITER_URL },
    } as never);
    let status = 0;
    let body = '';
    const res = {
      writeHead: (s: number) => { status = s; return res; },
      end: (b?: string) => { body = b ?? ''; },
      setHeader: () => {},
    };
    handler({ url: '/api/web/rooms', method: 'POST', headers: {} } as never, res as never);

    expect(status).toBe(421);
    expect(JSON.parse(body)).toMatchObject({ error: 'NODE_IS_REPLICA', writer: WRITER_URL });
  });
});
