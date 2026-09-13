// COST BUDGET: 4.1 s because CE-6b waits for the product's own DEFAULT_ENGINE_SPAWN_TIMEOUT_MS (5 s, src/stt/orchestrator-types.ts:27) to be the thing that finally emits a frame — measured 2026-09-13 dev-pc-a: CE-6b 4,311 ms of the file's 4,999 ms, and the file is 4,116 ms once the two 300 ms negative-assertion windows below became ordering barriers.
//
// ⚠️ THE OTHER NUMBERS IN THIS FILE ARE CEILINGS, NOT WAITS. `connect` 3000,
// `ack` 8000 and `once` 3000 are reached ONLY when the thing never arrives, so
// they cost nothing on a passing run and lowering them buys no time — it only
// moves the day a loaded box loses. Do not "tune" them; see the CE-6b header
// below for what happens when a wait is sized from a product deadline.
//
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

let server: BootstrapHandle;
let url: string;
const sockets: ClientSocket[] = [];

// GA-04: the server's deferred work (the mobile-drop grace window) runs on the
// injectable scheduler, so this replay can expire a 30 s window on demand
// instead of waiting for it. Nothing else in a standalone server uses it.
const pendingTimers = new Map<number, () => void>();
let timerSeq = 0;
let onArm: (() => void) | null = null;
const fakeSetTimeout = ((cb: () => void) => {
  const id = ++timerSeq;
  pendingTimers.set(id, cb);
  const arm = onArm;
  onArm = null;
  arm?.();
  return id as unknown as NodeJS.Timeout;
}) as unknown as typeof setTimeout;
/** Resolves when the server ARMS deferred work on the injectable scheduler —
 *  i.e. proof it has already processed the edge that arms it. Used instead of
 *  sleeping to find out whether a disconnect has been seen yet. */
function armedTimer(): Promise<void> {
  if (pendingTimers.size > 0) return Promise.resolve();
  return new Promise((resolve) => { onArm = resolve; });
}
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
/** Records every frame of `event` on a socket for as long as the test wants,
 *  and hands back the reader. Replaces the old `neverWithin(socket, event, ms)`
 *  window (deleted 2026-09-13): a fixed window is a stopwatch racing a
 *  stopwatch, and CE-6b's header below is the receipt for what that costs —
 *  its five 1200 ms probes all closed BEFORE the only frames that session ever
 *  emits, so they asserted that nothing arrived during a stretch in which
 *  nothing could have arrived. A negative is read after an ORDERING BARRIER
 *  instead (a round trip on the same socket): socket.io preserves per-connection
 *  order, so anything the server had already written to that socket is
 *  delivered before the ack of a request sent afterwards. No window, no sleep,
 *  and no load can beat it.
 *
 *  🔴 REVERSE CONTROLS FOR THE TWO EDGES THAT LOST THEIR WINDOW, measured red
 *  2026-09-13 — a negative read through a barrier has to still bite:
 *    · marker REVERSE-CONTROL-D — the delivery gate deleted from audio.handler.ts
 *      (`const fannedOut = roomUuid !== null`) ⇒ CE-6 FAILED on the record-only leg;
 *    · marker REVERSE-CONTROL-E — `isDeliberateLeave` forced to `true`, i.e. a blip
 *      drained on the transport edge ⇒ CE-1 FAILED on `leftFrames`.
 *  Both restored; `grep -rn "REVERSE-CONTROL-[DE]" apps/server-core/src` = 0. */
function record(socket: ClientSocket, event: string): unknown[] {
  const seen: unknown[] = [];
  socket.on(event, (d: unknown) => seen.push(d));
  return seen;
}

const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

/**
 * 🔴 card P1-CE6B (2026-09-02) — EVERY TEST IN THIS FILE MUST PASS ITS OWN
 * INSTANCE ID, and that is isolation, not decoration.
 *
 * All four tests used to register as `inst-couplingedge012`, so all four landed
 * in the SAME room, and `makeSttEmitter` resolves the PC leg through
 * `store.getPc(roomUuid)` — i.e. whichever PC socket registered into that room
 * LAST. CE-6 leaves a `delivery:'inject'` session whose engine spawn is still
 * hanging when it returns; five seconds later that session's engine-status and
 * its stop-time final were delivered to CE-6b's PC socket, in CE-6b's window,
 * looking exactly like the privacy leak CE-6b exists to catch.
 *
 * MEASURED: with one shared id, CE-6b's whole-test PC record reads
 * `['stt:engine-status','stt:final']` — frames from the PREVIOUS test. Nothing
 * saw it before, because the old probes had closed long before they arrived.
 * A shared room is a shared destination; give each test its own.
 */
async function pairMobile(instanceId: string): Promise<{ pc: ClientSocket; mobile: ClientSocket; token: string; roomUuid: string; pairingId: string }> {
  const pc = await connect();
  const reg = await ack<{ token: string; short_code: string; room_uuid: string; pc_id: string }>(pc, 'pc:register', {
    device_name: 'PC',
    client_instance_id: instanceId,
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
    const { pc, mobile, token, roomUuid, pairingId } = await pairMobile('inst-couplingedge-ce1');
    const leftFrames = record(pc, 'pc:mobile-left');
    // A blip is the transport dying UNANNOUNCED (server reason `transport close`).
    // It must be killed at the engine, not via socket.disconnect(): the latter
    // sends a namespace DISCONNECT packet first, which the server now reads as a
    // deliberate departure and drains immediately (CE-1b).
    mobile.io.engine.close();
    // GA-04 changed WHEN this edge fires, not whether: a drop is not a departure
    // until the mobile-drop grace window expires (blip debounce — a phone back inside
    // the window must leave the PC none the wiser).
    //
    // The negative is read against two FACTS rather than a 300 ms window: the
    // server has armed the grace timer (so it has demonstrably processed the
    // drop — a window could have closed before it even saw it, which is the
    // vacuous shape CE-6b was caught in), and a round trip on the PC's own
    // socket has come back (so any pc:mobile-left the server had written to
    // that connection was delivered first).
    await armedTimer();
    await ack(pc, 'pc:list-mobiles', {});
    expect(leftFrames).toEqual([]); // not drained on the transport edge
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
    const { pc, mobile, pairingId } = await pairMobile('inst-couplingedge-ce1b');
    const leftP = once<{ mobile_id: string }>(pc, 'pc:mobile-left');
    mobile.disconnect();
    expect((await leftP).mobile_id).toBe(pairingId); // ← no expireServerTimers()
    expect(pendingTimers.size).toBe(0);              // and nothing left armed
  });

  it("CE-6 (fan-out): delivery:'inject' fans audio:start to the PC; delivery:'none' does NOT", async () => {
    const { pc, mobile } = await pairMobile('inst-couplingedge-ce6');
    // delivery:'inject' → the PC receives the S→PC audio:start fan-out (drives its lock).
    const fannedP = once<Record<string, unknown>>(pc, 'audio:start');
    await ack(mobile, 'audio:start', { ...AUDIO_START, delivery: 'inject' }).catch(() => {}); // ack errors (no engine) — fan-out is independent
    const fanned = await fannedP;
    expect(fanned.mode).toBe('realtime');
    await ack(mobile, 'audio:stop', {}).catch(() => {});
    // delivery:'none' record-only → the PC must stay dark (no fan-out).
    // Read after an ordering barrier, not after a window: the fan-out emit is
    // inside the audio:start handler (audio.handler.ts symbol `fannedOut`,
    // `startPc.emit('audio:start', …)`), i.e. written to the PC's socket BEFORE
    // the mobile's ack was written. So a pc:list-mobiles sent after that ack
    // comes back strictly later on the PC's connection than any leaked frame.
    const pcSawStart = record(pc, 'audio:start');
    await ack(mobile, 'audio:start', { ...AUDIO_START, delivery: 'none' }).catch(() => {});
    await ack(pc, 'pc:list-mobiles', {});
    expect(pcSawStart).toEqual([]);
  });

  // 🔴 EXPLICIT TIMEOUT, and since 2026-09-02 it is the ONLY deadline in this test.
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
  //
  // 🔴🔴 CARD P1-CE6B (2026-09-02) — AND 5000+2000 WAS STILL A RACE, because the
  // frame it waits for IS the 5000 ms deadline firing. MEASURED here (worktree
  // p1-ce6b @ 7dd16640, 4 full-suite runs): sherpa-local's open() does not fail
  // fast on a box with no model — it hangs, so the ONLY thing that ever produces
  // a frame is `raceSpawnTimeout` rejecting with `engine spawn timeout after
  // 5000ms`. The mobile heard it at 6144 / 6449 / 6717 / 6959 ms against a
  // 7000 ms window: 40–856 ms of slack for scheduling jitter in a worker that is
  // also running 3,400 other tests. It lost 6 of 7 `verify:delivery` runs the day
  // the suite grew, with `expected false to be true` — and the number was never
  // the bug: A TEST THAT WAITS `product deadline + ε` IS A STOPWATCH RACING A
  // STOPWATCH, and widening ε only moves the day it loses.
  //
  // ⇒ THE WAIT IS NOW EVENT-DRIVEN AND HAS NO CLOCK OF ITS OWN. The explicit
  // 20_000 above is the single deadline; if the mobile is never told, this fails
  // as `Test timed out in 20000ms` at the `await mobileHeard` line, which is 4×
  // the product's cap instead of 1.4× and is not a number any load can beat.
  //
  // 🔴 THE PC HALF WAS WORSE THAN FLAKY, IT WAS VACUOUS. It used five 1200 ms
  // `neverWithin` probes started before audio:start — every one of them closed
  // about five seconds BEFORE the only frames this session ever emits. It was
  // asserting that nothing arrived during a stretch in which nothing could have
  // arrived.
  //
  // REVERSE CONTROL, measured 2026-09-02, three runs that separate the two
  // variables (delete the delivery gate in `engine/stt-factory.ts` —
  // `fanOutToPc = args.roomUuid !== null` — so the PC really does receive the
  // whole content leg):
  //   · old probes + shared room  → RED, but on `stt:engine-status` + `stt:final`
  //     belonging to CE-6's session, not to CE-6b's;
  //   · old probes + isolated room → GREEN. The gate is gone, the PC is receiving
  //     a record-only utterance, and the test says nothing. That is the number
  //     this whole edge is worth;
  //   · whole-test record + isolated room → RED on CE-6b's OWN frame.
  // So the old green was two defects cancelling: probes that could not see this
  // utterance, in a room where they could see somebody else's.
  //
  // The PC's record is therefore kept for the WHOLE test and read after the
  // mobile's frame is in hand, with a round trip on the PC's own socket as the
  // ordering barrier — socket.io preserves order per connection, so anything the
  // server already wrote to that socket is delivered before the ack of a request
  // we sent afterwards. No window, no sleep.
  it("CE-6b (content leg): delivery:'none' sends the PC no stt:* while the mobile still hears its session", { timeout: 20_000 }, async () => {
    const { pc, mobile } = await pairMobile('inst-couplingedge-ce6b');
    // No STT endpoint is reachable from a test box, so the engine layer runs its
    // connect ladder and narrates it on stt:engine-status — a REAL frame through
    // the REAL emitter. That is what makes this edge non-vacuous: the frames
    // genuinely fly, and the assertion is about WHERE they land.
    //
    // 🔴 [measured 2026-09-02] what actually flies here is engine-status{failed}
    // + stt:error{'engine spawn timeout after 5000ms'}, emitted together when
    // `raceSpawnTimeout` gives up on sherpa-local's open(). That is WHY the PC's
    // record below has to outlive a fixed window: nothing at all crosses this
    // wire for the first five seconds.
    const CONTENT_EVENTS = ['stt:interim', 'stt:final', 'stt:level', 'stt:error', 'stt:engine-status'] as const;
    const pcSaw: string[] = [];
    for (const e of CONTENT_EVENTS) pc.on(e, () => pcSaw.push(e));
    const mobileHeard = new Promise<string>((resolve) => {
      // 🔴 SIZED FROM NOTHING — see the header. The product's own deadline is
      // what produces this frame, so any window derived from it is a race with
      // it. The only deadline is the explicit per-test timeout.
      //
      // 🔴 The general shape is worth more than this line: a deadline defect
      // is STRUCTURALLY INVISIBLE on the fast machine that authored it — the
      // same reason the bundled-Node mismatch and the MSI host-Node dependency
      // were both green here and red everywhere else.
      mobile.once('stt:engine-status', () => resolve('stt:engine-status'));
      mobile.once('stt:error', () => resolve('stt:error'));
    });
    await ack(mobile, 'audio:start', { ...AUDIO_START, delivery: 'none' }).catch(() => {});
    expect(await mobileHeard).toMatch(/^stt:(engine-status|error)$/); // …nothing was swallowed
    // ORDERING BARRIER, not a settle: `pc:list-mobiles` is read-only and always
    // acks (`PcListMobilesSchema = z.object({})`), and its reply is written
    // after any leaked frame was, on the same connection.
    await ack(pc, 'pc:list-mobiles', {});
    expect(pcSaw).toEqual([]); // the content never went to the PC at all
    await ack(mobile, 'audio:stop', {}).catch(() => {});
  });
});
