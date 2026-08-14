// WP-R3.5 — REAL-server backing for the two server-authoritative coupling edges
// (the desktop-FSM half lives in apps/desktop/src/lib/replay/coupling-edges.test.ts):
//   CE-1 (pairing-drain half): a mobile drop DRAINS the room slot — the PC is told
//         pc:mobile-left and a reconcile shows the slot gone (server room FSM ↔
//         signaling FSM). This is the "drain PAIRING" half of the canonical 11 §1
//         edge; the desktop harness covers the "drain SESSION + reset capsule" half.
//   CE-6 (fan-out half): audio:start{delivery:'none'} is NEVER fanned out to the PC
//         (audio.handler: fannedOut = delivery !== 'none') — the destination FSM
//         gates the S→PC mirror, so a record-only utterance leaves the PC dark.
//   CE-6b (content half, GA-02): the same gate on the stt:* leg. The audio edge was
//         withheld but every transcript frame still crossed, so the PC really did
//         render text the user said to keep on the phone. Asserted here on a REAL
//         server because that is the only place the emitter, the room store and the
//         delivery intent meet.
//
// Both replay a recorded event sequence against a REAL in-process server (no engine
// needed — the fan-out is independent of STT wiring by design).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { DEFAULT_ENGINE_SPAWN_TIMEOUT_MS } from '../src/stt/orchestrator-types';

let server: BootstrapHandle;
let url: string;
const sockets: ClientSocket[] = [];

// GA-04: the server's deferred work (the mobile-drop grace window) runs on the
// injectable scheduler, so this replay can expire a 30 s window on demand
// instead of waiting for it. Nothing else in a standalone server uses it.
const pendingTimers = new Map<number, () => void>();
let timerSeq = 0;
const fakeSetTimeout = ((cb: () => void) => {
  const id = ++timerSeq;
  pendingTimers.set(id, cb);
  return id as unknown as NodeJS.Timeout;
}) as unknown as typeof setTimeout;
const fakeClearTimeout = ((h: unknown) => { pendingTimers.delete(h as number); }) as unknown as typeof clearTimeout;
function expireServerTimers(): void {
  const due = [...pendingTimers.values()];
  pendingTimers.clear();
  for (const cb of due) cb();
}

function connect(auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
function ack<T = Record<string, unknown>>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    // 3s was green solo and red under the full vitest fan-out (device-line
    // 2026-08-11 ×2: CE-6b died on `pc:register ack timeout` while the same
    // file passed alone). Parallel suites contend for disk/CPU; the register
    // itself is not slow — the wait budget was. Keep product timeouts alone.
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 8000);
    socket.emit(event, payload, (res: T) => { clearTimeout(t); resolve(res); });
  });
}
function once<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), 3000);
    socket.once(event, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function neverWithin(socket: ClientSocket, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let fired = false;
    const h = (): void => { fired = true; };
    socket.once(event, h);
    setTimeout(() => { socket.off(event, h); resolve(!fired); }, ms);
  });
}

const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

async function pairMobile(): Promise<{ pc: ClientSocket; mobile: ClientSocket; token: string; roomUuid: string; pairingId: string }> {
  const pc = await connect();
  const reg = await ack<{ token: string; short_code: string; room_uuid: string; pc_id: string }>(pc, 'pc:register', {
    device_name: 'PC',
    client_instance_id: 'inst-couplingedge012',
  });
  const mobile = await connect();
  const joinedP = once(pc, 'pc:mobile-joined');
  const pair = await ack<{ mobile_token: string; room_uuid: string; pairing_id: string }>(mobile, 'mobile:pair', { short_code: reg.short_code });
  await joinedP;
  return { pc, mobile, token: reg.token, roomUuid: pair.room_uuid, pairingId: pair.pairing_id };
}

beforeAll(async () => {
  const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'coupling-replay-secret-32-bytes-xxx' });
  server = await startServer(config, { setTimeoutFn: fakeSetTimeout, clearTimeoutFn: fakeClearTimeout });
  url = `http://localhost:${server.port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

describe('WP-R3.5 server-authoritative coupling edges (real in-process server)', () => {
  it('CE-1 (pairing drain): a mobile BLIP drains the slot at GRACE EXPIRY, not on the transport edge', async () => {
    const { pc, mobile, token, roomUuid, pairingId } = await pairMobile();
    // A blip is the transport dying UNANNOUNCED (server reason `transport close`).
    // It must be killed at the engine, not via socket.disconnect(): the latter
    // sends a namespace DISCONNECT packet first, which the server now reads as a
    // deliberate departure and drains immediately (CE-1b).
    mobile.io.engine.close();
    // GA-04 changed WHEN this edge fires, not whether: a drop is not a departure
    // until the mobile-drop grace window expires (blip debounce — a phone back inside
    // the window must leave the PC none the wiser).
    expect(await neverWithin(pc, 'pc:mobile-left', 300)).toBe(true);
    const leftP = once<{ mobile_id: string }>(pc, 'pc:mobile-left');
    expireServerTimers(); // the 30 s window runs out
    const left = await leftP;
    expect(left.mobile_id).toBe(pairingId); // the drained slot is named
    // Reconcile via a PC token-reconnect: the room now reports zero mobiles.
    pc.disconnect();
    const pc2 = await connect({ token });
    const recon = await ack<Record<string, unknown>>(pc2, 'pc:reconnect', { token });
    expect(recon.room_uuid).toBe(roomUuid);
    const mobiles = (recon.connectedMobiles ?? recon.mobiles ?? []) as unknown[];
    expect(Array.isArray(mobiles) ? mobiles.length : 0).toBe(0); // slot drained
  });

  it('CE-1b (deliberate leave): backing out of the instance drains the slot AT ONCE, no grace', async () => {
    // owner 2026-07-27: leaving the chat page retreated the PC capsule ~30 s
    // late, because a deliberate exit was being treated as a blip. The phone's
    // leaveRoom() calls socket.disconnect() → `client namespace disconnect`,
    // and that reason collapses the window instead of arming it.
    const { pc, mobile, pairingId } = await pairMobile();
    const leftP = once<{ mobile_id: string }>(pc, 'pc:mobile-left');
    mobile.disconnect();
    expect((await leftP).mobile_id).toBe(pairingId); // ← no expireServerTimers()
    expect(pendingTimers.size).toBe(0);              // and nothing left armed
  });

  it("CE-6 (fan-out): delivery:'inject' fans audio:start to the PC; delivery:'none' does NOT", async () => {
    const { pc, mobile } = await pairMobile();
    // delivery:'inject' → the PC receives the S→PC audio:start fan-out (drives its lock).
    const fannedP = once<Record<string, unknown>>(pc, 'audio:start');
    await ack(mobile, 'audio:start', { ...AUDIO_START, delivery: 'inject' }).catch(() => {}); // ack errors (no engine) — fan-out is independent
    const fanned = await fannedP;
    expect(fanned.mode).toBe('realtime');
    await ack(mobile, 'audio:stop', {}).catch(() => {});
    // delivery:'none' record-only → the PC must stay dark (no fan-out).
    const pcQuiet = neverWithin(pc, 'audio:start', 300);
    await ack(mobile, 'audio:start', { ...AUDIO_START, delivery: 'none' }).catch(() => {});
    expect(await pcQuiet).toBe(true);
  });

  // 🔴 EXPLICIT TIMEOUT, and it is the whole reason the previous window was 2500 ms.
  //
  // vitest's default per-test timeout is 5000 ms — the SAME number as
  // DEFAULT_ENGINE_SPAWN_TIMEOUT_MS. So a test that legitimately waits for the
  // product's own spawn deadline is racing the framework that runs it, and loses:
  // sizing the window to 5000+2000 turned CI's assertion failure into
  // `Test timed out in 5000ms` — MEASURED on the run after the first fix
  // (2026-08-08). The fix direction was right and incomplete.
  //
  // ⇒ The 2500 ms this replaced was probably not carelessness at all: it is what
  // fits under the default. That reason was never written down, so the number
  // looked arbitrary and the constraint it encoded was invisible — and the same
  // hidden ceiling is waiting for every other test in this repo that wants to
  // observe a product deadline of 5 s or more.
  it("CE-6b (content leg): delivery:'none' sends the PC no stt:* while the mobile still hears its session", { timeout: 20_000 }, async () => {
    const { pc, mobile } = await pairMobile();
    // No STT endpoint is reachable from a test box, so the engine layer runs its
    // connect ladder and narrates it on stt:engine-status — a REAL frame through
    // the REAL emitter. That is what makes this edge non-vacuous: the frames
    // genuinely fly, and the assertion is about WHERE they land.
    const mobileHeard = new Promise<boolean>((resolve) => {
      // 🔴 SIZED FROM THE PRODUCT'S OWN DEADLINE, not from how fast this machine
      // happens to be (§1-bis-18). The first frame the mobile can hear here is
      // the engine layer narrating a connect it cannot complete — and the
      // orchestrator gives that connect DEFAULT_ENGINE_SPAWN_TIMEOUT_MS before
      // it says anything. A hard-coded 2500 ms was therefore HALF the product's
      // own cap, and it passed here only because a local box refuses the
      // connection instantly (ECONNREFUSED) instead of hanging.
      //
      // MEASURED 2026-08-08: the first complete nine-stage CI run went red on
      // exactly this line — `expected false to be true` — on a runner where the
      // connect does not fail fast. That is the SAME shape the golden suite was
      // fixed for the day before (G2/G3/G10 waited 2500 ms for frames the
      // product emits at its own caps); this test was the member of that class
      // nobody scanned for. A red-list is also a sample.
      //
      // ⚠️ [CI unproven] THIS FIX HAS NO LOCAL REVERSE CONTROL, and that is a fact
      // about the machine, not an omission. Shrinking the window to 300 ms here
      // still passes (measured): a local box answers the doomed connect with an
      // instant ECONNREFUSED, so the frame arrives long before any window
      // expires. ⇒ the local green proves the test is not broken; it CANNOT
      // prove the CI red is fixed. That verdict belongs to the next CI run.
      // 🔴 The general shape is worth more than this line: a deadline defect
      // is STRUCTURALLY INVISIBLE on the fast machine that authored it — the
      // same reason the bundled-Node mismatch and the MSI host-Node dependency
      // were both green here and red everywhere else.
      const t = setTimeout(() => resolve(false), DEFAULT_ENGINE_SPAWN_TIMEOUT_MS + 2_000);
      const done = (): void => { clearTimeout(t); resolve(true); };
      mobile.once('stt:engine-status', done);
      mobile.once('stt:error', done);
    });
    const pcLeaks = Promise.all(
      (['stt:interim', 'stt:final', 'stt:level', 'stt:error', 'stt:engine-status'] as const)
        .map((e) => neverWithin(pc, e, 1200).then((quiet) => (quiet ? null : e))),
    );
    await ack(mobile, 'audio:start', { ...AUDIO_START, delivery: 'none' }).catch(() => {});
    expect((await pcLeaks).filter(Boolean)).toEqual([]); // the content never went to the PC at all
    expect(await mobileHeard).toBe(true); // …but nothing was swallowed either
    await ack(mobile, 'audio:stop', {}).catch(() => {});
  });
});
