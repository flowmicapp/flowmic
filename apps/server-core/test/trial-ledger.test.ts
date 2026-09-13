// Card M4-01 / card R-1b — the unregistered-trial arithmetic, on a real sqlite
// file and the real repos.
//
// SPEC-REF:
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//     (owner 2026-09-11 — one lifetime 120 s per browser identity, no daily
//     reset, no per-network decay; SUPERSEDES the sequence this file used to pin)
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.3 / §3.1
//   src/billing/trial-ledger.ts · src/billing/trial-ip-bucket.ts
//   src/db/schema-trial.ts (why there is no `ms_used` column, which is what the
//     "spent site-wide today" case below is really checking)
//
// 🔴 THE CASES THAT MATTER MOST are the two that a wrong implementation passes
// every other assertion in this file while failing:
//   · "the same browser tomorrow" — a `day` anywhere in the claim lookup silently
//     re-opens every spent trial at midnight, which is the exact behaviour owner
//     replaced, and nothing else here would go red;
//   · "one browser, both entry paths" — the marketing demo and a PC pairing share
//     ONE identity, so a second book (or the same book with a second key) hands
//     out two two-minute allowances wearing one label.

// ── 🔴 REVERSE CONTROL, MEASURED RED (2026-09-11, card R-1b) ──────────────
// Marker `REVERSE-CONTROL-A`: a DAILY RESET put back into `TrialLedger.claim`
// (`const existing = existingRaw && existingRaw.day === utcDay(input.nowMs) ?
// existingRaw : null`) — i.e. exactly the behaviour owner §10 replaced.
//   RED: 「🔴 does NOT come back tomorrow, or the day after」 failed with
//   `Error: UNIQUE constraint failed: trial_ledger.device_uid`
//   (src/db/repos/trial-ledger.repo.ts insert ← src/billing/trial-ledger.ts claim).
// ⚠️ WORTH READING TWICE: the case went red through the DATABASE, not through a
// wrong number. That is the partial unique index doing the job schema-trial.ts
// claims for it — a second identity for one browser is not merely unasserted,
// it is unrepresentable. Restored;
// `grep -rn REVERSE-CONTROL-A apps/server-core/src` = 0, and all 26 cases green.

// ── 🔴 REVERSE CONTROL, MEASURED RED (2026-09-11, card R-1b) ──────────────
// Marker `REVERSE-CONTROL-A`: a DAILY RESET put back into `TrialLedger.claim`
// (`const existing = existingRaw && existingRaw.day === utcDay(input.nowMs) ?
// existingRaw : null`) — i.e. exactly the behaviour owner §10 replaced.
//   RED: 「🔴 does NOT come back tomorrow, or the day after」 failed with
//   `Error: UNIQUE constraint failed: trial_ledger.device_uid`
//   (src/db/repos/trial-ledger.repo.ts insert ← src/billing/trial-ledger.ts claim).
// ⚠️ WORTH READING TWICE: the case went red through the DATABASE, not through a
// wrong number. That is the partial unique index doing the job schema-trial.ts
// claims for it — a second identity for one browser is not merely unasserted,
// it is unrepresentable. Restored;
// `grep -rn REVERSE-CONTROL-A apps/server-core/src` = 0, and all 26 cases green.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';
import { makeUserRepo } from '../src/db/repos/user.repo';
import { makeTrialLedgerRepo } from '../src/db/repos/trial-ledger.repo';
import {
  makeTrialLedger, trialLimitsFrom, TRIAL_LIFETIME_GRANT_MS,
  type TrialLedger,
} from '../src/billing/trial-ledger';
import { ipBucketOf, ipPrefix } from '../src/billing/trial-ip-bucket';
import { planLimits } from '../src/billing/plans';

/** 2026-09-09T12:00:00Z — a fixed instant so `day` is a constant in the file. */
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

let dir: string;
let db: DatabaseSync;
let ledger: TrialLedger;
let n = 0;

/** Claim WITHOUT declaring a browser identity — the older-web-build shape. */
function mint(bucket: string, atMs = NOW) {
  return claim(null, bucket, atMs);
}

/** Claim AS a browser — owner §10's shape, and the one production sends. */
function claim(deviceUid: string | null, bucket = 'bucket-a', atMs = NOW) {
  return ledger.claim({
    deviceUid,
    ipBucket: bucket,
    nowMs: atMs,
    tokenTtlMs: HOUR,
    newId: () => `anon-${(n += 1)}`,
    newToken: () => `fm_test_${(n += 1)}`,
  });
}

/** Write to the ONE meter (`usage_records`) — never to the ledger row. The whole
 *  「what is left」 arithmetic has to come back through this, or the test is
 *  asking the implementation to confirm itself. */
function spend(userId: string, ms: number, month = '2026-09-09') {
  db.prepare(
    `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
     VALUES (?,?,?,0,0,?)
     ON CONFLICT(user_id,month) DO UPDATE SET stt_minutes=excluded.stt_minutes`,
  ).run(userId, month, ms / 60_000, new Date(NOW).toISOString());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-trial-'));
  db = openDatabase(join(dir, 'trial.sqlite'));
  ledger = makeTrialLedger({ rows: makeTrialLedgerRepo(db), users: makeUserRepo(db) });
  n = 0;
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the allowance (owner §10)', () => {
  it('is 「2 分钟」, once, and is a scalar rather than a table', () => {
    expect(TRIAL_LIFETIME_GRANT_MS).toBe(120_000);
  });

  it('gives every NEW browser identity the whole two minutes', () => {
    expect(claim('wb-1').grantedMs).toBe(120_000);
    expect(claim('wb-2').grantedMs).toBe(120_000);
    expect(claim('wb-3').grantedMs).toBe(120_000);
    expect(claim('wb-4').grantedMs).toBe(120_000);
  });

  it('does not decay with how busy the network is — the caps are elsewhere', () => {
    // 🔴 THE SUPERSEDED BEHAVIOUR, PINNED AS ITS OWN NEGATIVE. Four browsers on
    // ONE bucket used to be worth 120/60/30/0; under owner §10 they are worth
    // 120 each, and the IP/global ceilings that bound the abuse live in
    // http/web-anon-routes.ts, where they decide whether a request is served at
    // all and never how many seconds it is worth.
    const grants = ['wb-a', 'wb-b', 'wb-c', 'wb-d'].map((uid) => claim(uid, 'one-bucket').grantedMs);
    expect(grants).toEqual([120_000, 120_000, 120_000, 120_000]);
  });
});

describe('claiming as a browser identity', () => {
  it('mints once and then RETURNS THE SAME IDENTITY, not a second one', () => {
    const first = claim('wb-same');
    const again = claim('wb-same');
    expect(again.userId).toBe(first.userId);
    expect(again.reused).toBe(true);
    expect(first.reused).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 1 });
  });

  it('hands back what is LEFT of the one two minutes, off the meter', () => {
    const first = claim('wb-spent');
    expect(first.remainingMs).toBe(120_000);
    spend(first.userId, 95_000);
    const again = claim('wb-spent');
    expect(again.usedMs).toBe(95_000);
    expect(again.remainingMs).toBe(25_000);
    // The GRANT is untouched: it is written once, at mint. A reuse that rewrote
    // it is the one way a second 120 s could be handed out.
    expect(again.grantedMs).toBe(120_000);
    expect(ledger.grantedMsFor(first.userId)).toBe(120_000);
  });

  it('never reports a negative remainder for an identity that overspent', () => {
    const out = claim('wb-over');
    spend(out.userId, 200_000);
    expect(claim('wb-over').remainingMs).toBe(0);
  });

  it('🔴 does NOT come back tomorrow, or the day after', () => {
    // The case owner's ruling is: 「只要不清空浏览器缓存就要记住」. A `day` in the
    // claim lookup would make each of these a fresh 120 s and would break
    // nothing else in this file.
    const first = claim('wb-tomorrow');
    spend(first.userId, 120_000);
    for (const days of [1, 2, 7, 30]) {
      const later = claim('wb-tomorrow', 'bucket-a', NOW + days * 24 * HOUR);
      expect(later.userId).toBe(first.userId);
      expect(later.reused).toBe(true);
      expect(later.remainingMs).toBe(0);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 1 });
  });

  it('🔴 shares ONE identity between the site demo and a PC pairing', () => {
    // The two entry paths differ only in which network the caller came from and
    // which module called: both reach this method with the same `wb-` uid. owner
    // §10: 「网页扫 PC 的未登录会话 + 官网体验页（同一套身份）」.
    const onTheMarketingSite = claim('wb-both', 'bucket-site');
    spend(onTheMarketingSite.userId, 90_000);
    const inFrontOfADesktop = claim('wb-both', 'bucket-home');
    expect(inFrontOfADesktop.userId).toBe(onTheMarketingSite.userId);
    expect(inFrontOfADesktop.remainingMs).toBe(30_000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 1 });
  });

  it('rotates the token on a reuse, because the old one has an hour on it', () => {
    const first = claim('wb-token');
    const again = claim('wb-token', 'bucket-a', NOW + 3 * HOUR);
    expect(again.token).not.toBe(first.token);
    // The old credential is dead, the new one resolves, and both name one identity.
    expect(ledger.resolveToken(first.token, NOW + 3 * HOUR)).toBeNull();
    expect(ledger.resolveToken(again.token, NOW + 3 * HOUR)).toEqual({
      userId: first.userId, grantedMs: 120_000,
    });
  });

  it('treats a different browser as a different visitor', () => {
    const a = claim('wb-a');
    spend(a.userId, 120_000);
    const b = claim('wb-b');
    expect(b.userId).not.toBe(a.userId);
    expect(b.remainingMs).toBe(120_000);
  });

  it('declares NO identity ⇒ a fresh mint every time (an older web build)', () => {
    // Stated as behaviour rather than defended: the alternative is refusing a
    // client that has done nothing wrong, and the route's caps bound the cost.
    const first = mint('bucket-a');
    const second = mint('bucket-a');
    expect(second.userId).not.toBe(first.userId);
    expect(second.grantedMs).toBe(120_000);
    expect(second.reused).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trial_ledger WHERE device_uid IS NULL").get()).toEqual({ n: 2 });
  });

  it('does not let an empty or blank uid become one shared identity', () => {
    // '' matching '' would collapse every uid-less caller into ONE trial —
    // 120 s for the whole internet, which fails in the opposite direction.
    const a = claim('');
    const b = claim('   ');
    expect(b.userId).not.toBe(a.userId);
    expect(b.reused).toBe(false);
  });
});

describe('minting the users row', () => {
  it('marks the users row anonymous and nothing else', () => {
    const out = mint('bucket-a');
    const user = makeUserRepo(db).findById(out.userId);
    expect(user?.anonymous).toBe(true);
    expect(user?.email).toBeNull();
    expect(user?.password_hash).toBeNull();
    expect(user?.is_admin).toBe(false);
    expect(user?.permanent_free).toBe(false);
    expect(user?.plan).toBe('free');
  });
});

describe('the token', () => {
  it('resolves to its identity while it is alive', () => {
    const out = mint('bucket-a');
    expect(ledger.resolveToken(out.token, NOW + 1000)).toEqual({
      userId: out.userId, grantedMs: 120_000,
    });
  });

  it('stops resolving the moment it expires', () => {
    const out = mint('bucket-a');
    expect(ledger.resolveToken(out.token, out.expiresAtMs)).toBeNull();
    expect(ledger.resolveToken(out.token, out.expiresAtMs + 1)).toBeNull();
  });

  it('answers null for an unknown token, the same way it answers an expired one', () => {
    expect(ledger.resolveToken('fm_nope', NOW)).toBeNull();
    expect(ledger.resolveToken('', NOW)).toBeNull();
  });
});

describe('the two site-wide daily reads', () => {
  it('counts identities per bucket per day', () => {
    mint('bucket-a');
    mint('bucket-a');
    mint('bucket-b');
    expect(ledger.bucketCountToday('bucket-a', NOW)).toBe(2);
    expect(ledger.bucketCountToday('bucket-b', NOW)).toBe(1);
    expect(ledger.bucketCountToday('bucket-a', NOW + 24 * HOUR)).toBe(0);
  });

  it('sums minutes GRANTED today across every bucket', () => {
    mint('bucket-a'); // 120
    mint('bucket-a'); // 120
    mint('bucket-b'); // 120
    expect(ledger.msGrantedToday(NOW)).toBe(360_000);
    expect(ledger.msGrantedToday(NOW + 24 * HOUR)).toBe(0);
  });

  it('counts a REUSE as neither a mint nor a fresh grant', () => {
    // The abuse caps read these two numbers. A reuse that showed up in either
    // would let a returning visitor push a network over a ceiling it is not
    // spending anything new against.
    claim('wb-x', 'bucket-a');
    claim('wb-x', 'bucket-a');
    claim('wb-x', 'bucket-a');
    expect(ledger.bucketCountToday('bucket-a', NOW)).toBe(1);
    expect(ledger.msGrantedToday(NOW)).toBe(120_000);
  });

  it('reads minutes SPENT today off usage_records, not off a column of its own', () => {
    // 🔴 The point of this case. schema-trial.ts refuses to carry an `ms_used`
    // column because the meter is `usage_records`; if that JOIN ever became a
    // stored number, this case is where the two would part company — it writes
    // ONLY to the meter and expects the ledger to see it.
    const a = mint('bucket-a');
    expect(ledger.msUsedToday(NOW)).toBe(0);
    spend(a.userId, 90_000);
    expect(ledger.msUsedToday(NOW)).toBe(90_000);
  });
});

describe('the limits an anonymous identity gets', () => {
  it(`is free's table with ONLY stt_minutes replaced by the grant`, () => {
    const free = planLimits('free');
    expect(trialLimitsFrom(120_000)).toEqual({ ...free, stt_minutes: 2 });
    expect(trialLimitsFrom(30_000)).toEqual({ ...free, stt_minutes: 0.5 });
    expect(trialLimitsFrom(0)).toEqual({ ...free, stt_minutes: 0 });
  });

  it('never widens a device ceiling, which would be a capability wall in reverse', () => {
    const free = planLimits('free');
    expect(trialLimitsFrom(120_000).pcs).toBe(free.pcs);
    expect(trialLimitsFrom(120_000).mobiles).toBe(free.mobiles);
  });
});

describe('the IP bucket', () => {
  it('keeps a whole IPv4 address and only the /64 of an IPv6 one', () => {
    expect(ipPrefix('203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefix('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002');
    expect(ipPrefix('2001:db8::1')).toBe('2001:0db8:0000:0000');
  });

  it('collapses two addresses inside one /64 to one bucket, and separates two /64s', () => {
    const salt = 'salt';
    expect(ipBucketOf('2001:db8:1:2:3:4:5:6', salt)).toBe(ipBucketOf('2001:db8:1:2::99', salt));
    expect(ipBucketOf('2001:db8:1:2::1', salt)).not.toBe(ipBucketOf('2001:db8:1:3::1', salt));
  });

  it('puts every address it cannot parse into ONE shared bucket, not a fresh one each', () => {
    const salt = 'salt';
    expect(ipBucketOf('not-an-address', salt)).toBe(ipBucketOf('', salt));
    expect(ipPrefix('not-an-address')).toBe('(unknown)');
  });

  it('is not the address, and changes with the salt', () => {
    expect(ipBucketOf('203.0.113.7', 'a')).not.toContain('203');
    expect(ipBucketOf('203.0.113.7', 'a')).not.toBe(ipBucketOf('203.0.113.7', 'b'));
    expect(ipBucketOf('203.0.113.7', 'a')).toHaveLength(32);
  });
});
