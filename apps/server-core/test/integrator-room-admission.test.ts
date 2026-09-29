// W6b: real bootstrap + HTTP mint + socket.io pairing/reconnect. Database damage
// is deliberate input, never a fake admission result. No STT engine or handset
// is represented by this probe; it proves the production admission boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const ORIGIN = 'https://integration.example';
const KEY = `fmpk_${'a'.repeat(32)}`;
let server: BootstrapHandle;
let endpoint: string;
const clients: Socket[] = [];

beforeEach(async () => {
  vi.stubEnv('FLOWMIC_TRUSTED_PROXIES', '127.0.0.1,::1');
  server = await startServer(loadConfig({
    mode: 'saas', secret: 'w6-admission-test-secret-32-bytes-long', port: 0,
    dbPath: ':memory:', mockBilling: false, trustedProxies: ['127.0.0.1', '::1'],
  }));
  endpoint = `http://127.0.0.1:${server.port}`;
  for (const id of ['owner', 'other']) server.db.users.insert({ id, display_name: id, plan: 'free' });
  server.db.integratorKeys.insert({
    id: 'key', user_id: 'owner', publishable_key: KEY, origins: [ORIGIN],
    quota_minutes: 1, label: 'Integration', created_at: Date.now(),
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server.close();
  vi.unstubAllEnvs();
});

async function connect(origin?: string): Promise<Socket> {
  const client = io(endpoint, { transports: ['websocket'], forceNew: true, reconnection: false,
    ...(origin ? { extraHeaders: { origin } } : {}) });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 3000);
    client.once('connect', () => { clearTimeout(timer); resolve(); });
    client.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return client;
}

async function ack(client: Socket, event: string, payload: unknown): Promise<Record<string, any>> {
  return await client.timeout(3000).emitWithAck(event, payload) as Record<string, any>;
}

async function room() {
  const response = await fetch(`${endpoint}/api/web/rooms`, {
    method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ auth: { kind: 'publishable_key' } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { room_token: string; pair_url: string };
  const pc = server.db.pcs.findByToken(body.room_token)!;
  expect(pc.room_kind).toBe('integrator');
  return { ...body, pc };
}

function damage(pcId: string, kind: string): void {
  if (kind === 'missing edge') {
    server.db.raw.prepare('DELETE FROM integrator_rooms WHERE pc_device_id=?').run(pcId);
  } else if (kind === 'foreign owner') {
    server.db.raw.prepare('UPDATE integrator_keys SET user_id=? WHERE id=?').run('other', 'key');
  } else {
    // Model a partial/corrupt replicated relationship in this in-memory DB.
    server.db.raw.exec('PRAGMA foreign_keys=OFF');
    try { server.db.raw.prepare('UPDATE integrator_rooms SET key_id=? WHERE pc_device_id=?').run('absent-key', pcId); }
    finally { server.db.raw.exec('PRAGMA foreign_keys=ON'); }
  }
}

describe('W6b integrator billing relationship admission', () => {
  it('EMB-14 refuses the 21st visitor over HTTP with the existing wait response, then releases on stop', async () => {
    server.db.users.setPermanentFree('owner', true);
    server.db.raw.prepare("UPDATE integrator_keys SET quota_minutes=NULL WHERE id='key'").run();
    server.db.settings.write('owner', 'stt.routings', [
      { language: '*', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '' },
    ]);
    const mint = (i: number) => fetch(`${endpoint}/api/web/rooms`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
        'x-forwarded-for': `10.0.0.${i}` },
      body: JSON.stringify({ auth: { kind: 'publishable_key' }, pairing: 'local' }),
    });
    const microphones: Socket[] = [];
    for (let i = 1; i <= 20; i++) {
      const response = await mint(i);
      expect(response.status).toBe(200);
      const ticket = await response.json() as Record<string, any>;
      const mic = await connect(ORIGIN);
      expect((await ack(mic, 'mobile:reconnect', { token: ticket.local_mic_token, device_uid: `wb-emb14-${i}`, client: 'web' })).error).toBeUndefined();
      expect(await ack(mic, 'audio:start', { mode: 'realtime', source_lang: 'en', sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', delivery: 'none' })).toEqual({ ok: true });
      microphones.push(mic);
    }
    const refused = await mint(21);
    expect(refused.status, '21st visitor must not be admitted').toBe(429);
    expect(await refused.json()).toEqual({ error: 'WEB_ROOM_RATE_LIMITED', retry_after_ms: 1000 });
    await ack(microphones[0]!, 'audio:stop', {});
    expect((await mint(22)).status).toBe(200);
    for (const mic of microphones.slice(1)) await ack(mic, 'audio:stop', {});
  }, 30_000);

  it('EMB-1 local microphone reconnects without allocating a short code and preserves host billing', async () => {
    const response = await fetch(`${endpoint}/api/web/rooms`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { kind: 'publishable_key' }, pairing: 'local' }),
    });
    expect(response.status).toBe(200);
    const local = await response.json() as Record<string, any>;
    expect(local).toMatchObject({ code: null, pair_url: null });
    const pc = server.db.pcs.findByToken(local.room_token)!;
    expect(pc.short_code).toBe('');
    const target = await connect(ORIGIN);
    expect((await ack(target, 'pc:reconnect', { token: local.room_token, client: 'web' })).error).toBeUndefined();
    const mic = await connect(ORIGIN);
    const joined = await ack(mic, 'mobile:reconnect', {
      token: local.local_mic_token, device_uid: 'wb-emb-local', client: 'web',
    });
    expect(joined.error).toBeUndefined();
    expect(joined.pairing_id).toBe(local.local_pairing_id);
    expect(server.io.sockets.sockets.get(mic.id!)?.data.auth).toMatchObject({
      userId: 'owner', integratorKeyId: 'key', payerReason: 'host',
    });
    mic.disconnect();
    const foreign = await connect('https://foreign.example');
    expect((await ack(foreign, 'mobile:reconnect', { token: local.local_mic_token })).error)
      .toBe('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    damage(pc.id, 'missing edge');
    const damaged = await connect(ORIGIN);
    expect((await ack(damaged, 'mobile:reconnect', { token: local.local_mic_token })).error)
      .toBe('PC_HANDSHAKE_PENDING');
  });

  it.each(['missing edge', 'missing key', 'foreign owner'])('pair refuses %s before minting or joining', async (kind) => {
    const r = await room();
    damage(r.pc.id, kind);
    const client = await connect();
    const result = await ack(client, 'mobile:pair', { qr_payload: r.pair_url, client: 'web', device_uid: 'wb-w6-local-mic' });
    expect(result).toMatchObject({ error: 'PC_HANDSHAKE_PENDING' });
    expect(result.mobile_token).toBeUndefined();
    expect(server.db.mobiles.listByPc(r.pc.id)).toHaveLength(0);
    const live = server.io.sockets.sockets.get(client.id!);
    expect(live?.data.auth).toBeNull();
    expect(live?.data.roomUuid).toBeUndefined();
    expect(server.db.integratorKeys.findById('key')?.used_ms).toBe(0);
  });

  it.each(['missing edge', 'missing key', 'foreign owner'])('reconnect refuses %s while preserving the pairing', async (kind) => {
    const r = await room();
    const first = await connect();
    const paired = await ack(first, 'mobile:pair', { qr_payload: r.pair_url, client: 'web', device_uid: 'wb-w6-local-mic' });
    expect(paired.error).toBeUndefined();
    expect(server.io.sockets.sockets.get(first.id!)?.data.auth).toMatchObject({ userId: 'owner', integratorKeyId: 'key' });
    first.disconnect();
    damage(r.pc.id, kind);
    const returning = await connect();
    const refused = await ack(returning, 'mobile:reconnect', { token: paired.mobile_token });
    expect(refused).toMatchObject({ error: 'PC_HANDSHAKE_PENDING' });
    expect(server.io.sockets.sockets.get(returning.id!)?.data.auth).toBeNull();
    expect(server.io.sockets.sockets.get(returning.id!)?.data.roomUuid).toBeUndefined();
    expect(server.db.mobiles.findByToken(paired.mobile_token)).not.toBeNull();
    // A repaired relationship restores THIS pairing, without reminting it.
    server.db.raw.prepare('UPDATE integrator_keys SET user_id=? WHERE id=?').run('owner', 'key');
    server.db.integratorKeys.bindRoom(r.pc.id, 'key', Date.now());
    const recovered = await ack(returning, 'mobile:reconnect', { token: paired.mobile_token });
    expect(recovered.error).toBeUndefined();
    expect(recovered.pairing_id).toBe(paired.pairing_id);
    expect(server.io.sockets.sockets.get(returning.id!)?.data.auth).toMatchObject({ userId: 'owner', integratorKeyId: 'key' });
  });

  it('an ordinary web room needs no integrator key relationship', async () => {
    const r = await room();
    server.db.raw.prepare("UPDATE pc_devices SET room_kind='web' WHERE id=?").run(r.pc.id);
    server.db.raw.prepare('DELETE FROM integrator_rooms WHERE pc_device_id=?').run(r.pc.id);
    const client = await connect();
    const paired = await ack(client, 'mobile:pair', { qr_payload: r.pair_url, client: 'web', device_uid: 'wb-w6-ordinary-mic' });
    expect(paired.error).toBeUndefined();
    const auth = server.io.sockets.sockets.get(client.id!)?.data.auth;
    expect(auth).toMatchObject({ userId: 'owner', payerReason: 'peer' });
    expect(auth.integratorKeyId).toBeUndefined();
  });
});
