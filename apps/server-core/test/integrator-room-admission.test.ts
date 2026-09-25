// W6b: real bootstrap + HTTP mint + socket.io pairing/reconnect. Database damage
// is deliberate input, never a fake admission result. No STT engine or handset
// is represented by this probe; it proves the production admission boundary.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const ORIGIN = 'https://integration.example';
const KEY = `fmpk_${'a'.repeat(32)}`;
let server: BootstrapHandle;
let endpoint: string;
const clients: Socket[] = [];

beforeEach(async () => {
  server = await startServer(loadConfig({
    mode: 'saas', secret: 'w6-admission-test-secret-32-bytes-long', port: 0,
    dbPath: ':memory:', mockBilling: false, trustedProxies: [],
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
});

async function connect(): Promise<Socket> {
  const client = io(endpoint, { transports: ['websocket'], forceNew: true, reconnection: false });
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
