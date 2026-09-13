// Card MP-1 — the publishable-key store and the policy over it.
//
// SPEC-REF:
//   src/billing/integrator-quota.ts (what a key is, and why `Origin` is not a
//     security boundary)
//   src/db/repos/integrator-key.repo.ts (the store)
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §2 / §5

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import {
  looksLikePublishableKey, newPublishableKey, normalizeOrigin, originAllowed,
  makeIntegratorKeyGuard, PUBLISHABLE_KEY_PREFIX,
} from '../src/billing/integrator-quota';

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const PERIOD = '2026-09-11';

let dir: string;
let db: DbConnection;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-mp1-'));
  db = createDbConnection({ dbPath: join(dir, 'test.db'), encryptionKey: deriveKey('g-mp1-test-secret') });
  db.users.insert({ id: 'T', email: 't@integrator.test', password_hash: 'x', display_name: 'T' });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeKey(over: Partial<Parameters<DbConnection['integratorKeys']['insert']>[0]> = {}): ReturnType<DbConnection['integratorKeys']['insert']> {
  return db.integratorKeys.insert({
    id: 'ik-1',
    user_id: 'T',
    publishable_key: newPublishableKey(),
    origins: ['https://host.example'],
    quota_minutes: null,
    label: null,
    created_at: NOW,
    ...over,
  });
}

describe('the key STRING', () => {
  it('carries the prefix a human reads a log line with, and is unguessable', () => {
    const k = newPublishableKey();
    expect(k.startsWith(PUBLISHABLE_KEY_PREFIX)).toBe(true);
    expect(looksLikePublishableKey(k)).toBe(true);
    // 128 bits of hex. Not a secret (it ships inside a page) but still not
    // walkable — anybody who could enumerate one could spend an integrator's
    // minutes without ever visiting their site.
    expect(k.length).toBe(PUBLISHABLE_KEY_PREFIX.length + 32);
    expect(new Set(Array.from({ length: 64 }, () => newPublishableKey())).size).toBe(64);
  });

  it('the shape check refuses everything that is not one of ours', () => {
    for (const bad of ['', 'fmpk_', 'fmpk_zz', `${PUBLISHABLE_KEY_PREFIX}${'g'.repeat(32)}`, 'fm_abcdef', newPublishableKey().toUpperCase()]) {
      expect(looksLikePublishableKey(bad), bad).toBe(false);
    }
  });
});

describe('the ORIGIN allowlist', () => {
  it('normalises both sides, so a stored trailing slash and a header without one are one origin', () => {
    expect(normalizeOrigin('https://Example.com/')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com');
    expect(normalizeOrigin('http://example.com:8080')).toBe('http://example.com:8080');
  });

  it('🔴 an ABSENT or opaque Origin is a REFUSAL, not a pass', () => {
    // The classic CORS-allowlist inversion: treating 「no header」 as 「no
    // restriction applies」 would make the only thing that costs an attacker
    // anything removable by deleting a header.
    const key = { origins: ['https://host.example'] };
    for (const header of [undefined, null, '', 'null', 'not a url', 'file:///etc/passwd']) {
      expect(originAllowed(key, header as string | undefined), String(header)).toBe(false);
    }
    // …and the positive control, so the zeros above mean 「refused」 rather than
    // 「this predicate refuses everything」.
    expect(originAllowed(key, 'https://host.example')).toBe(true);
  });

  it('🔴 exact match only — no wildcards, no suffix rules', () => {
    const key = { origins: ['https://host.example'] };
    // A subdomain takeover is the ordinary way a third party's page turns
    // hostile, so `*.host.example` would be a generous-looking hole.
    expect(originAllowed(key, 'https://evil.host.example')).toBe(false);
    expect(originAllowed(key, 'https://host.example.evil.com')).toBe(false);
    // Scheme and port are part of the identity.
    expect(originAllowed(key, 'http://host.example')).toBe(false);
    expect(originAllowed(key, 'https://host.example:8443')).toBe(false);
  });

  it('an EMPTY allowlist allows nothing — never everything', () => {
    expect(originAllowed({ origins: [] }, 'https://host.example')).toBe(false);
  });
});

describe('the store', () => {
  it('round-trips a key, and a malformed origins column reads as 「allows nothing」', () => {
    const row = makeKey({ origins: ['https://a.test', 'https://b.test'], quota_minutes: 5, label: 'site' });
    expect(db.integratorKeys.findByPublishableKey(row.publishable_key)).toEqual(row);
    expect(db.integratorKeys.listByUser('T').map((k) => k.id)).toEqual(['ik-1']);
    // Corrupt the JSON behind the repo's back — the failure direction that costs
    // a working key rather than an integrator's minutes.
    db.raw.prepare('UPDATE integrator_keys SET origins = ? WHERE id = ?').run('{not json', 'ik-1');
    expect(db.integratorKeys.findById('ik-1')?.origins).toEqual([]);
  });

  it('revoke is scoped to the owner, idempotent, and keeps the first stamp', () => {
    makeKey();
    expect(db.integratorKeys.revoke('somebody-else', 'ik-1', NOW)).toBe(false);
    expect(db.integratorKeys.findById('ik-1')?.revoked_at).toBeNull();
    expect(db.integratorKeys.revoke('T', 'ik-1', NOW)).toBe(true);
    expect(db.integratorKeys.findById('ik-1')?.revoked_at).toBe(NOW);
    // Re-revoking answers true (the caller asked for a state and the state
    // holds) and does NOT move the stamp — 「when was this key stopped」 has one
    // answer.
    expect(db.integratorKeys.revoke('T', 'ik-1', NOW + 60_000)).toBe(true);
    expect(db.integratorKeys.findById('ik-1')?.revoked_at).toBe(NOW);
  });

  it('🔴 the usage counter ROLLS OVER on a new period instead of accumulating', () => {
    makeKey({ quota_minutes: 10 });
    db.integratorKeys.addUsage('ik-1', PERIOD, 60_000);
    db.integratorKeys.addUsage('ik-1', PERIOD, 30_000);
    expect(db.integratorKeys.findById('ik-1')).toMatchObject({ used_ms: 90_000, used_period: PERIOD });
    db.integratorKeys.addUsage('ik-1', '2026-10-11', 5_000);
    // Not 95_000: a different cycle starts from zero, in the SAME statement that
    // adds, so two settles racing cannot leave the counter half-rolled.
    expect(db.integratorKeys.findById('ik-1')).toMatchObject({ used_ms: 5_000, used_period: '2026-10-11' });
  });

  it('the room→key edge round-trips, and a room nobody minted answers null', () => {
    makeKey();
    db.pcs.insert({
      id: 'pc-1', user_id: 'T', device_name: 'FlowMic Web',
      device_token: 'tok-1', room_uuid: 'room-1', short_code: '4321', room_kind: 'integrator',
    });
    db.integratorKeys.bindRoom('pc-1', 'ik-1', NOW);
    expect(db.integratorKeys.keyIdForRoom('pc-1')).toBe('ik-1');
    expect(db.integratorKeys.keyIdForRoom('pc-nope')).toBeNull();
  });
});

describe('the guard', () => {
  const guard = (): ReturnType<typeof makeIntegratorKeyGuard> => makeIntegratorKeyGuard({
    keys: db.integratorKeys,
    usagePeriodKey: () => PERIOD,
  });

  it('admits a live key from an allowed origin', () => {
    const row = makeKey();
    const v = guard().admit(row.publishable_key, 'https://host.example');
    expect(v.ok).toBe(true);
    expect(v.ok && v.key.id).toBe('ik-1');
  });

  it('🔴 unknown, revoked and wrong-origin are THREE reasons and only TWO answers', () => {
    const row = makeKey();
    const g = guard();
    // Unknown and revoked are deliberately one answer at the route (the caller
    // learns 「not usable」 and not 「it once existed」); they are two reasons HERE
    // so the operator's log line can say which.
    expect(g.admit(newPublishableKey(), 'https://host.example')).toEqual({ ok: false, reason: 'unknown' });
    expect(g.admit('garbage', 'https://host.example')).toEqual({ ok: false, reason: 'unknown' });
    expect(g.admit(row.publishable_key, 'https://evil.test')).toEqual({ ok: false, reason: 'origin' });
    db.integratorKeys.revoke('T', 'ik-1', NOW);
    expect(g.admit(row.publishable_key, 'https://host.example')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('🔴 the ORIGIN is checked AFTER the key exists, so a bad origin is not an existence oracle', () => {
    const row = makeKey();
    // Same origin, two keys: one real, one not. If the origin check ran first
    // both would answer `origin`, and the difference below is what proves the
    // order rather than a comment claiming it.
    expect(guard().admit(row.publishable_key, 'https://evil.test').ok).toBe(false);
    expect(guard().admit(newPublishableKey(), 'https://evil.test')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a key with NO sub-quota adds no ceiling — Infinity, so `Math.min` is a no-op', () => {
    makeKey({ quota_minutes: null });
    expect(guard().remainingMs('ik-1', NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('a key WITH a sub-quota counts down inside the cycle and refills in the next one', () => {
    makeKey({ quota_minutes: 2 });
    expect(guard().remainingMs('ik-1', NOW)).toBe(120_000);
    db.integratorKeys.addUsage('ik-1', PERIOD, 90_000);
    expect(guard().remainingMs('ik-1', NOW)).toBe(30_000);
    db.integratorKeys.addUsage('ik-1', PERIOD, 60_000);
    // Clamped at zero rather than going negative — a negative would flow into
    // `Math.min` and make every OTHER ceiling look exceeded too.
    expect(guard().remainingMs('ik-1', NOW)).toBe(0);
    // A different cycle: the counter's period no longer matches, so the read
    // sees zero used. Driven through a guard whose period key answers the NEXT
    // month rather than by editing the row.
    const nextMonth = makeIntegratorKeyGuard({ keys: db.integratorKeys, usagePeriodKey: () => '2026-10-11' });
    expect(nextMonth.remainingMs('ik-1', NOW)).toBe(120_000);
  });

  it('🔴 a key this process cannot read answers 0, NEVER Infinity (design §5)', () => {
    // The failure direction that matters: an unreadable ceiling must refuse, or
    // a replica that cannot see the counter would serve an integrator's page
    // against no ceiling at all.
    expect(guard().remainingMs('ik-does-not-exist', NOW)).toBe(0);
    makeKey({ quota_minutes: null });
    db.integratorKeys.revoke('T', 'ik-1', NOW);
    // …and a REVOKED key is zero even though its `quota_minutes` is null, which
    // would otherwise have read as 「no ceiling」.
    expect(guard().remainingMs('ik-1', NOW)).toBe(0);
  });
});
