// Card GRANT-1 — the INNER (read-only + grant) gates of timeline.handler.ts,
// driven DIRECTLY on the handler with a fake socket, i.e. deliberately
// BYPASSING the web allowlist. That bypass is the whole point (design §3.3):
// in production the allowlist refuses a web push/tombstone FIRST, so the
// TIMELINE_WEB_READ_ONLY code is unreachable through the wire while the outer
// gate stands — it exists for the day someone loosens the allowlist, and a
// gate that can only be tested through a door that blocks it would be pinned
// by nothing. (The wire-level behaviour — allowlist first — is pinned in
// test/web-grant-preview.test.ts 「gate ORDER」.)

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { TIMELINE_E2E_PREFIX } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { registerTimelineHandlers } from '../src/socket/handlers/timeline.handler';
import type { AuthContext } from '../src/auth/middleware';

const NOW = 1_754_900_000_000;

function world(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('readonly-gate-secret-32-bytes-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  return db;
}

interface Driven {
  emit(event: string, payload: unknown): Promise<unknown>;
  emitted: Array<{ event: string; payload: unknown }>;
}

/** Register the REAL timeline handlers on a minimal fake socket carrying the
 *  given AuthContext, and hand back a driver that invokes them the way
 *  socket.io would (payload + ack). */
function driven(db: DbConnection, auth: AuthContext | null, now: () => number = () => NOW): Driven {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    id: 'fake-socket-1',
    data: { auth },
    on(event: string, fn: (payload: unknown, ack: unknown) => void) {
      handlers.set(event, fn);
      return socket;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  };
  registerTimelineHandlers(socket as unknown as Socket, { repo: db.timeline, grants: db.timelineGrants, verifiedEmail: { emailVerifiedAt: () => NOW }, now });
  return {
    emit(event, payload): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const h = handlers.get(event);
        if (!h) return reject(new Error(`no handler registered for ${event}`));
        h(payload, (r: unknown) => resolve(r));
      });
    },
    emitted,
  };
}

const WEB: AuthContext = { userId: 'u1', kind: 'web' };
const MOBILE: AuthContext = { userId: 'u1', kind: 'mobile', pairingId: 'p1', deviceId: 'pc1' };
const VALID_PUSH = {
  entries: [{ id: 'e1', seq: 0, ciphertext: `${TIMELINE_E2E_PREFIX}payload`, created_at: NOW, schema_ver: 1 }],
};

describe('timeline handler: kind-web is READ-ONLY (the second gate, allowlist bypassed)', () => {
  it('web push → TIMELINE_WEB_READ_ONLY, and NOTHING was stored — with a VALID payload, so only the gate can be the refuser', async () => {
    const db = world();
    const web = driven(db, WEB);
    const r = (await web.emit('timeline:push', VALID_PUSH)) as { error?: string };
    expect(r.error).toBe('TIMELINE_WEB_READ_ONLY');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM timeline_blobs').get()).toEqual({ n: 0 });
    db.close();
  });

  it('web tombstone → TIMELINE_WEB_READ_ONLY, and the existing row is untouched', async () => {
    const db = world();
    db.timeline.push('u1', [{ id: 'e1', ciphertext: `${TIMELINE_E2E_PREFIX}keep`, created_at: NOW, schema_ver: 1 }]);
    const web = driven(db, WEB);
    const r = (await web.emit('timeline:tombstone', { ids: ['e1'] })) as { error?: string };
    expect(r.error).toBe('TIMELINE_WEB_READ_ONLY');
    expect(db.raw.prepare("SELECT deleted, ciphertext FROM timeline_blobs WHERE id='e1'").get()).toEqual({
      deleted: 0,
      ciphertext: `${TIMELINE_E2E_PREFIX}keep`,
    });
    db.close();
  });

  it('web pull: refused with no grant, admitted under a live one, refused again past its expiry', async () => {
    const db = world();
    db.timeline.push('u1', [{ id: 'e1', ciphertext: `${TIMELINE_E2E_PREFIX}readable`, created_at: NOW, schema_ver: 1 }]);
    let t = NOW;
    const web = driven(db, WEB, () => t);

    const before = (await web.emit('timeline:pull', {})) as { error?: string };
    expect(before.error).toBe('TIMELINE_GRANT_REQUIRED');

    db.timelineGrants.create({ gid: 'g1', user_id: 'u1', origin: 'https://x', expires_at: NOW + 3_600_000 });
    const under = (await web.emit('timeline:pull', {})) as { error?: string; blobs: { ciphertext: string }[] };
    expect(under.error).toBeUndefined();
    expect(under.blobs.map((b) => b.ciphertext)).toEqual([`${TIMELINE_E2E_PREFIX}readable`]);

    t = NOW + 3_600_001; // one ms past expires_at — no sweeper involved
    const after = (await web.emit('timeline:pull', {})) as { error?: string };
    expect(after.error).toBe('TIMELINE_GRANT_REQUIRED');
    db.close();
  });

  it('web pull under a REVOKED grant is refused — revocation needs no push, only the next ask', async () => {
    const db = world();
    db.timelineGrants.create({ gid: 'g1', user_id: 'u1', origin: 'https://x', expires_at: NOW + 3_600_000 });
    const web = driven(db, WEB);
    expect(((await web.emit('timeline:pull', {})) as { error?: string }).error).toBeUndefined();
    expect(db.timelineGrants.revoke('g1', 'u1')).toBe(true);
    expect(((await web.emit('timeline:pull', {})) as { error?: string }).error).toBe('TIMELINE_GRANT_REQUIRED');
    db.close();
  });

  it('regression pin: a MOBILE socket pushes, pulls and tombstones exactly as before — no grant anywhere', async () => {
    const db = world();
    const phone = driven(db, MOBILE);
    const push = (await phone.emit('timeline:push', VALID_PUSH)) as { ok?: boolean };
    expect(push.ok).toBe(true);
    const pull = (await phone.emit('timeline:pull', {})) as { error?: string; blobs: unknown[] };
    expect(pull.error).toBeUndefined();
    expect(pull.blobs).toHaveLength(1);
    // …and the pull-result mirror emit still fires for the device path.
    expect(phone.emitted.map((e) => e.event)).toContain('timeline:pull-result');
    const tomb = (await phone.emit('timeline:tombstone', { ids: ['e1'] })) as { ok?: boolean; tombstoned?: number };
    expect(tomb).toEqual({ ok: true, tombstoned: 1 });
    db.close();
  });
});
