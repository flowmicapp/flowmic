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

    // 3. Settings save-on-change for a STORED key: the PC updates its own
    // scenario-inference override table, the phone sees the broadcast.
    // (2026-09-03: this step used to push `stt.polish` FROM the phone and expect
    // the PC to hear it. That key is phone-owned now — it rides the phone's
    // socket and is never stored or broadcast — so the stored-key round trip is
    // driven from the PC, and the phone-owned contract is asserted in 3b.)
    const updatedOnMobile = once(mobile, 'settings:updated');
    const upd = await ack<Record<string, unknown>>(pc, 'settings:update', { key: 'scenario.inference.overrides', value: { chrome: 'browsing' } });
    expect(upd.ok).toBe(true);
    const broadcast = (await updatedOnMobile) as { key: string; value: unknown; updated_at?: string };
    // 🔴 G2 (04 §3.7-a) widened this payload with `updated_at`. The old strict
    // `toEqual` asserted 「these two keys and nothing else」, which is the promise
    // that changed — so the shape is updated deliberately, not patched around.
    // The stamp's VALUE is not pinned here (this is a live server with a real
    // clock); what is pinned is that it crossed the wire at all, because a
    // stripped stamp is this feature's whole failure mode and it is silent.
    expect(broadcast.key).toBe('scenario.inference.overrides');
    expect(broadcast.value).toEqual({ chrome: 'browsing' });
    expect(typeof broadcast.updated_at).toBe('string');

    // 3b. A PHONE-OWNED key from the phone over settings:update is REFUSED by
    // name (owner follow-up 2026-09-03: the bundle rides audio:start /
    // compose:start, see phone-prefs-carrier.test.ts) — the PC's settings:list
    // (which lists every stored row) must never show it, and the PC hears no
    // broadcast. `scenario.card` rather than `stt.polish` here, because the PC
    // arm SYNTHESISES an stt.polish default and the absence of a row would be
    // invisible behind it.
    const pcHeard: unknown[] = [];
    pc.on('settings:updated', (p: unknown) => pcHeard.push(p));
    const own = await ack<Record<string, unknown>>(mobile, 'settings:update', {
      key: 'scenario.card', value: { professions: ['golden'], domains: [], packs: [], terms: [] },
    });
    expect(own.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(String(own.message)).toContain('phone-owned');

    // 4. settings:list reflects the STORED write (+ seeded defaults) on the PC arm …
    const list = await ack<{ items: { key: string; value: unknown }[] }>(pc, 'settings:list', {});
    const keys = list.items.map((i) => i.key);
    expect(keys).toContain('scenario.inference.overrides');
    expect(keys).toContain('stt.routings'); // seeded default present
    expect(keys).not.toContain('scenario.card'); // 3b never landed
    expect(pcHeard).toEqual([]);
    // … and the MOBILE arm answers the one PC fact it still needs, nothing else (D5).
    const mobileList = await ack<{ items: { key: string; value: unknown }[] }>(mobile, 'settings:list', {});
    expect(mobileList.items.map((i) => i.key)).toEqual(['capability.llm']);

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
