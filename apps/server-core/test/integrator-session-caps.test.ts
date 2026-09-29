import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { RoomStore } from '../src/room/store';
import type { QuotaGuard } from '../src/billing/quota-guard';
import { IntegratorSessionCaps, INTEGRATOR_SESSION_MS, INTEGRATOR_DAILY_MS } from '../src/billing/integrator-session-caps';
import { SttAllowancePool } from '../src/billing/stt-allowance-pool';
import { reserveSessionAllowance } from '../src/engine/stt-session-allowance';
import { AudioSession } from '../src/stt/audio/session';

function visitorRig() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('emb14-test-secret') });
  db.users.insert({ id: 'host', display_name: 'Host', plan: 'max' });
  for (const key of ['key', 'other']) db.integratorKeys.insert({ id: key, user_id: 'host',
    publishable_key: `fmpk_${key}`, origins: ['https://example.com'], quota_minutes: null, label: key, created_at: Date.now() });
  const caps = new IntegratorSessionCaps(db.raw, 'stable-private-test-salt');
  let serial = 0;
  const room = (ip = '2001:db8::1', key = 'key') => {
    const id = `room-${serial++}`;
    db.pcs.insert({ id, user_id: 'host', device_name: id, device_token: id, room_uuid: id, short_code: '', room_kind: 'integrator' });
    caps.bindRoom(id, key, ip);
    return id;
  };
  const pool = new SttAllowancePool();
  const start = (id = room(), key = 'key') => {
    const allowance = reserveSessionAllowance(pool, { userId: 'host', roomId: id, keyId: key,
      payerMs: () => 180_000_000, keyMs: () => Infinity, planCapMs: 1_800_000, visitors: caps });
    const session = new AudioSession();
    allowance.install(session);
    const stops: string[] = [];
    session.on('auto_stopped', (reason) => stops.push(reason));
    session.start();
    return { session, stops, finish: () => { session.finalize(); allowance.settle(0, () => {}); } };
  };
  return { db, caps, room, start };
}

afterEach(() => vi.useRealTimers());

describe('EMB-14 concurrent metering', () => {
  it('three concurrent sessions cannot spend more than the host remaining 1000 ms', () => {
    vi.useFakeTimers();
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('emb14-test-secret') });
    db.users.insert({ id: 'host', display_name: 'Host', plan: 'max' });
    db.settings.write('host', 'stt.routings', [
      { language: '*', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '' },
    ]);
    let spent = 0;
    const quota = { remainingSttMs: () => Math.max(0, 1000 - spent), continuousCapMs: () => 1_800_000,
      ensureQuota: () => {} } as unknown as QuotaGuard;
    const factory = makeSttSessionFactory({ settings: db.settings, mode: 'saas', store: new RoomStore<Socket>(), quota,
      integratorKeys: { remainingMs: () => Infinity } });
    const sessions = Array.from({ length: 3 }, (_, i) => factory({ id: `s${i}`, data: {}, emit: () => {} } as unknown as Socket, {
      userId: 'host', integratorKeyId: `key-${i}`, mode: 'realtime', delivery: 'none', sourceLang: 'en',
      onComplete: (ms) => { spent += ms; },
    }));
    for (const session of sessions) session.pushChunk(0, Buffer.alloc(19_200).toString('base64'), Date.now());
    vi.advanceTimersByTime(600);
    for (const session of sessions) session.dispose();
    db.close();
    expect(spent).toBeLessThanOrEqual(1000);
  });

  it('single-session default is 5 minutes and ends through session_cap / hard_limit', () => {
    const r = visitorRig();
    const live = r.start();
    expect(INTEGRATOR_SESSION_MS).toBe(300_000);
    vi.advanceTimersByTime(299_999);
    expect(live.session.state).toBe('recording');
    vi.advanceTimersByTime(1);
    expect(live.session.state).toBe('auto_stopped');
    expect(live.session.limitOrigin).toBe('session_cap');
    expect(live.stops).toEqual(['hard_limit']);
    live.finish(); r.db.close();
  });

  it('daily default is 30 minutes shared across same-/64 rooms; another key/bucket and next day remain usable', () => {
    const r = visitorRig();
    expect(INTEGRATOR_DAILY_MS).toBe(1_800_000);
    for (let i = 0; i < 6; i++) {
      const live = r.start(r.room(`2001:db8::${i + 1}`));
      vi.advanceTimersByTime(300_000);
      live.finish();
    }
    const exhausted = r.start(r.room('2001:db8::ffff'));
    vi.advanceTimersByTime(0);
    expect(exhausted.session.state).toBe('auto_stopped');
    expect(exhausted.session.limitOrigin).toBe('session_cap');
    exhausted.finish();
    for (const [ip, key] of [['2001:db8:1::1', 'key'], ['2001:db8::1', 'other']]) {
      const live = r.start(r.room(ip, key), key);
      vi.advanceTimersByTime(1);
      expect(live.session.state).toBe('recording');
      live.finish();
    }
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    const tomorrow = r.start();
    vi.advanceTimersByTime(1);
    expect(tomorrow.session.state).toBe('recording');
    tomorrow.finish(); r.db.close();
  });

  it('daily holds survive a new controller and concurrent tabs cannot reuse the last minute', () => {
    const r = visitorRig();
    for (let i = 0; i < 5; i++) {
      const live = r.start(); vi.advanceTimersByTime(300_000); live.finish();
    }
    const partial = r.start(); vi.advanceTimersByTime(240_000); partial.finish();
    const last = r.start();
    const duplicate = r.start();
    vi.advanceTimersByTime(0);
    expect(duplicate.session.state).toBe('auto_stopped');
    duplicate.finish();
    vi.advanceTimersByTime(60_000);
    expect(last.session.state).toBe('auto_stopped');
    expect(last.session.limitOrigin).toBe('session_cap');
    last.finish();
    const restarted = new IntegratorSessionCaps(r.db.raw, 'stable-private-test-salt');
    const afterRestart = restarted.take(r.room(), 'key');
    expect(afterRestart.capMs).toBe(0);
    afterRestart.release(0); r.db.close();
  });

  it('the 21st active session is refused; a settled slot and another key admit', () => {
    const r = visitorRig();
    const active = Array.from({ length: 20 }, (_, i) => r.start(r.room(`10.0.0.${i + 1}`)));
    expect(r.caps.admission('key')).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(() => r.start(r.room('10.0.0.21'))).toThrow('REGISTER_RATE_LIMITED');
    const other = r.start(r.room('10.0.0.21', 'other'), 'other');
    other.finish();
    active[0]!.finish();
    expect(r.caps.admission('key').allowed).toBe(true);
    for (const live of active.slice(1)) live.finish();
    r.db.close();
  });

  it('a reservation accounts for sibling keys, refresh, failed starts and unused settlement', () => {
    const pool = new SttAllowancePool();
    const a = pool.reserve('host', 1000, 600, 'a', 1000);
    const b = pool.reserve('host', 1000, 600, 'b', 1000);
    expect([a.ms, b.ms]).toEqual([600, 400]);
    expect(pool.available('host', 1000, 'a', 1000, a)).toBe(600);
    pool.release(b);
    expect(pool.available('host', 1000, 'a', 1000, a)).toBe(1000);
    pool.release(a);
    expect(pool.reserve('host', 800, 600, 'a', 100).ms).toBe(100);
  });

  it('factory build failures refund visitor and monetary holds before the next start', () => {
    const r = visitorRig();
    const id = r.room();
    const socket = { data: { auth: { kind: 'mobile', userId: 'host', deviceId: id } }, emit: () => {} } as unknown as Socket;
    const quota = { remainingSttMs: () => 1000, continuousCapMs: () => 1_800_000, ensureQuota: () => {} } as unknown as QuotaGuard;
    const factory = makeSttSessionFactory({ settings: r.db.settings, mode: 'saas', store: new RoomStore<Socket>(), quota,
      integratorKeys: { remainingMs: () => Infinity }, integratorSessions: r.caps });
    const args = { userId: 'host', integratorKeyId: 'key', mode: 'realtime' as const, delivery: 'none' as const,
      sourceLang: 'en', onComplete: () => {} };
    r.db.settings.write('host', 'stt.routings', []);
    for (let i = 0; i < 21; i++) expect(() => factory(socket, args)).toThrow();
    expect(r.caps.admission('key').allowed).toBe(true);
    const check = r.caps.take(id, 'key');
    expect(check.capMs).toBe(300_000);
    check.release(0);
    r.db.settings.write('host', 'stt.routings', [
      { language: '*', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '' },
    ]);
    const live = factory(socket, args);
    expect(live.quotaDeadlineAt).toBe(Date.now() + 1000);
    live.dispose(); r.db.close();
  });

  it('replicas cannot start a visitor against a replicated allowance', () => {
    const r = visitorRig();
    const replica = new IntegratorSessionCaps(r.db.raw, 'stable-private-test-salt', Date.now, false);
    expect(() => replica.take(r.room(), 'key')).toThrow('NODE_IS_REPLICA');
    r.db.close();
  });

  it('deleting the host cascades through both visitor tables', () => {
    const r = visitorRig();
    const live = r.start(); vi.advanceTimersByTime(1000); live.finish();
    for (const table of ['integrator_visitor_rooms', 'integrator_visitor_days']) {
      expect((r.db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
    }
    r.db.raw.prepare("DELETE FROM users WHERE id='host'").run();
    for (const table of ['integrator_visitor_rooms', 'integrator_visitor_days']) {
      expect((r.db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    r.db.close();
  });
});
