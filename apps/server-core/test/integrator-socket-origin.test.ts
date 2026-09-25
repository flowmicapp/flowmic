// Real bootstrap, HTTP room mint and Socket.IO transports. Origin is an actual
// request header, never a mocked policy result. This is not a handset/UI test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const HOST = 'https://integration.example';
const OTHER = 'https://other-integrator.example';
const KEY = `fmpk_${'a'.repeat(32)}`;
let server: BootstrapHandle;
let endpoint: string;
const clients: Socket[] = [];

beforeEach(async () => {
  server = await startServer(loadConfig({
    mode: 'saas', secret: 'w6-origin-test-secret-32-bytes-long', port: 0,
    dbPath: ':memory:', mockBilling: false, trustedProxies: [],
  }));
  endpoint = `http://127.0.0.1:${server.port}`;
  for (const [id, origin, key] of [['owner', HOST, KEY], ['other', OTHER, `fmpk_${'b'.repeat(32)}`]] as const) {
    server.db.users.insert({ id, display_name: id, plan: 'free' });
    server.db.integratorKeys.insert({ id, user_id: id, publishable_key: key, origins: [origin], quota_minutes: 1, label: id, created_at: Date.now() });
  }
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server.close();
});

async function connect(origin?: string, token?: string, transport: 'websocket' | 'polling' = 'websocket'): Promise<Socket> {
  const client = io(endpoint, {
    transports: [transport], forceNew: true, reconnection: false,
    auth: token ? { token } : {}, extraHeaders: origin === undefined ? {} : { Origin: origin },
  });
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
    method: 'POST', headers: { Origin: HOST, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ auth: { kind: 'publishable_key' } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { room_token: string; pair_url: string };
  return { ...body, pc: server.db.pcs.findByToken(body.room_token)! };
}
function unjoined(client: Socket) {
  const live = server.io.sockets.sockets.get(client.id!);
  expect(live?.data.auth).toBeNull();
  expect(live?.data.roomUuid).toBeUndefined();
}

describe('W6c room-bound integrator Socket Origin', () => {
  it.each(['websocket', 'polling'] as const)('host target connects over %s; another registered key origin cannot', async (transport) => {
    const r = await room();
    await expect(connect(OTHER, r.room_token, transport)).rejects.toThrow('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    const target = await connect(HOST, r.room_token, transport);
    const result = await ack(target, 'pc:reconnect', { token: r.room_token });
    expect(result.error).toBeUndefined();
    expect(server.io.sockets.sockets.get(target.id!)?.data.auth).toMatchObject({ kind: 'pc', deviceId: r.pc.id });
  });

  it.each([undefined, '', 'null', 'https://foreign.example'])('target handshake refuses Origin %s', async (origin) => {
    const r = await room();
    await expect(connect(origin, r.room_token)).rejects.toThrow('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    expect(server.db.pcs.findByToken(r.room_token)?.is_online).toBe(0);
  });

  it('tokenless target reconnect checks actual header before changing online state', async () => {
    const r = await room();
    const target = await connect(OTHER);
    const result = await ack(target, 'pc:reconnect', { token: r.room_token, origin: HOST });
    expect(result).toMatchObject({ error: 'WEB_ROOM_ORIGIN_NOT_ALLOWED' });
    expect(server.db.pcs.findByToken(r.room_token)?.is_online).toBe(0);
    unjoined(target);
  });

  it.each([undefined, 'https://flowmic.app', HOST])('microphone retains legitimate Origin %s', async (origin) => {
    const r = await room();
    const microphone = await connect(origin);
    const paired = await ack(microphone, 'mobile:pair', { qr_payload: r.pair_url, client: 'web', device_uid: 'wb-w6-origin' });
    expect(paired.error).toBeUndefined();
    expect(paired.mobile_token).toBeTypeOf('string');
    microphone.disconnect();
    const returning = await connect(origin, paired.mobile_token);
    expect((await ack(returning, 'mobile:reconnect', { token: paired.mobile_token })).error).toBeUndefined();
  });

  it('foreign microphone cannot pair or reconnect; existing pairing remains recoverable', async () => {
    const r = await room();
    const stranger = await connect(OTHER);
    const denied = await ack(stranger, 'mobile:pair', { qr_payload: r.pair_url, client: 'web', device_uid: 'wb-w6-foreign', origin: HOST });
    expect(denied).toMatchObject({ error: 'WEB_ROOM_ORIGIN_NOT_ALLOWED' });
    expect(server.db.mobiles.listByPc(r.pc.id)).toHaveLength(0);
    unjoined(stranger);
    const mic = await connect(HOST);
    const paired = await ack(mic, 'mobile:pair', { qr_payload: r.pair_url, client: 'web', device_uid: 'wb-w6-legitimate' });
    expect(paired.error).toBeUndefined();
    mic.disconnect();
    await expect(connect(OTHER, paired.mobile_token)).rejects.toThrow('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    expect(await ack(stranger, 'mobile:reconnect', { token: paired.mobile_token })).toMatchObject({ error: 'WEB_ROOM_ORIGIN_NOT_ALLOWED' });
    unjoined(stranger);
    expect(server.db.mobiles.findByToken(paired.mobile_token)).not.toBeNull();
    const restored = await connect(HOST);
    expect((await ack(restored, 'mobile:reconnect', { token: paired.mobile_token })).pairing_id).toBe(paired.pairing_id);
  });

  it('polling CORS reflects live registered origins only and observes revocation immediately', async () => {
    const request = (origin: string) => fetch(`${endpoint}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } });
    expect((await request(HOST)).headers.get('access-control-allow-origin')).toBe(HOST);
    expect((await request(OTHER)).headers.get('access-control-allow-origin')).toBe(OTHER);
    expect((await request('https://foreign.example')).headers.get('access-control-allow-origin')).toBeNull();
    server.db.raw.prepare('UPDATE integrator_keys SET revoked_at=? WHERE id=?').run(Date.now(), 'owner');
    expect((await request(HOST)).headers.get('access-control-allow-origin')).toBeNull();
  });
});
