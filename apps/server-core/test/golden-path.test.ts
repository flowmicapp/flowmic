// Golden path (acceptance): standalone cold start → pc:register → short code →
// mobile:pair → settings:update/list (save-on-change) → PC disconnect → pc:reconnect.
// Runs against a real in-process server over a real socket.io client.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

let server: BootstrapHandle;
let url: string;
const sockets: ClientSocket[] = [];

function connect(auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}

function ack<T = Record<string, unknown>>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function once(socket: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} event timeout`)), 3000);
    socket.once(event, (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

beforeAll(async () => {
  const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'integration-test-secret-32-bytes-long' });
  server = await startServer(config);
  url = `http://localhost:${server.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

describe('standalone golden path', () => {
  it('pc:register → mobile:pair → settings round-trip → pc:reconnect', async () => {
    // 1. PC registers (no token yet).
    const pc = await connect();
    const reg = await ack<Record<string, string>>(pc, 'pc:register', {
      device_name: 'Test PC',
      client_instance_id: 'inst-abcdef0123456789',
    });
    expect(reg.token).toMatch(/^fm_[0-9a-f]{64}$/);
    expect(reg.short_code).toMatch(/^\d{4}$/);
    expect(reg.room_uuid).toBeTruthy();

    // 2. Mobile pairs with the short code; PC is notified.
    const mobile = await connect();
    // GA-07: a real phone answers the server's sys:ping liveness probe
    // (health_handler.dart). The golden path must model a phone that CAN prove
    // itself — otherwise step 5's pc:reconnect would (correctly) evict it as a
    // zombie and this would stop being the golden path.
    mobile.on('sys:ping', (p: { nonce: string }) => mobile.emit('sys:pong', { nonce: p.nonce, ok: true }));
    const joinedP = once(pc, 'pc:mobile-joined');
    const pair = await ack<Record<string, unknown>>(mobile, 'mobile:pair', { short_code: reg.short_code });
    expect((pair.mobile_token as string)).toMatch(/^fm_[0-9a-f]{64}$/);
    expect(pair.room_uuid).toBe(reg.room_uuid);
    expect(pair.pc_online).toBe(true);
    const joined = (await joinedP) as { mobile_id: string };
    expect(joined.mobile_id).toBe(pair.pairing_id);

    // 3. Settings save-on-change: mobile updates a key, PC sees the broadcast. WP-R4-6
    // made stt.polish a REAL typed key read at audio:start (SttPolishSchema), so
    // this round-trip uses its valid {enabled:false} value — a bare `true` would
    // now poison the later audio:start snapshot for the shared standalone user.
    const updatedOnPc = once(pc, 'settings:updated');
    const upd = await ack<Record<string, unknown>>(mobile, 'settings:update', { key: 'stt.polish', value: { enabled: false } });
    expect(upd.ok).toBe(true);
    const broadcast = (await updatedOnPc) as { key: string; value: unknown; updated_at?: string };
    // 🔴 G2 (04 §3.7-a) widened this payload with `updated_at`. The old strict
    // `toEqual` asserted 「these two keys and nothing else」, which is the promise
    // that changed — so the shape is updated deliberately, not patched around.
    // The stamp's VALUE is not pinned here (this is a live server with a real
    // clock); what is pinned is that it crossed the wire at all, because a
    // stripped stamp is this feature's whole failure mode and it is silent.
    expect(broadcast.key).toBe('stt.polish');
    expect(broadcast.value).toEqual({ enabled: false });
    expect(typeof broadcast.updated_at).toBe('string');

    // 4. settings:list reflects the write (+ seeded defaults).
    const list = await ack<{ items: { key: string; value: unknown }[] }>(mobile, 'settings:list', {});
    const keys = list.items.map((i) => i.key);
    expect(keys).toContain('stt.polish');
    expect(keys).toContain('stt.routings'); // seeded default present

    // 5. PC disconnects, then reconnects by token → same room.
    pc.disconnect();
    const pc2 = await connect({ token: reg.token });
    const recon = await ack<Record<string, unknown>>(pc2, 'pc:reconnect', { token: reg.token });
    expect(recon.room_uuid).toBe(reg.room_uuid);
    expect(recon.pc_id).toBe(reg.pc_id);
    // GA-07/GA-26: the roster is liveness-CONFIRMED — the phone pongs, so it is
    // in the ack exactly once (a snapshot would say the same here; the point is
    // that this one is evidence).
    expect(recon.connectedMobiles).toEqual([pair.pairing_id]);
  });

  it('rejects the removed singular stt.routing key (no silent resurrection)', async () => {
    const pc = await connect();
    await ack(pc, 'pc:register', { device_name: 'PC2', client_instance_id: 'inst-1111222233334444' });
    const res = await ack<Record<string, unknown>>(pc, 'settings:update', { key: 'stt.routing', value: {} });
    expect(res.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  // WP-R1-3 wired the engine layer, obsoleting the original "seam absent"
  // assertion; the invariant that survives is routing's no-implicit-fallback
  // red line (06 §4 / constraint #16): with no routing resolvable, audio:start
  // must fail loud with STT_CONFIG_MISSING — never silently pick an engine.
  it('audio:start fails loud when no routing resolves (no implicit fallback)', async () => {
    const pc = await connect();
    const reg = await ack<Record<string, string>>(pc, 'pc:register', { device_name: 'PC3', client_instance_id: 'inst-aaaabbbbccccdddd' });
    const mobile = await connect();
    await ack(mobile, 'mobile:pair', { short_code: reg.short_code });
    await ack(mobile, 'settings:update', { key: 'stt.routings', value: [] });
    const errP = once(mobile, 'stt:error');
    const res = await ack<Record<string, unknown>>(mobile, 'audio:start', {
      sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh',
    });
    expect(res.error).toBe('STT_CONFIG_MISSING'); // explicit, not swallowed
    const sttErr = (await errP) as { code: string };
    expect(sttErr.code).toBe('STT_CONFIG_MISSING');
  });
});
