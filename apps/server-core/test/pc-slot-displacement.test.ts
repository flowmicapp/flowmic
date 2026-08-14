// F-3 Fix#2 — what happens to the PC socket that just lost the room slot.
//
// F-3 (M5 real-device, reproduced 3×): after the desktop's sidecar is revived by
// its watchdog, the devices page permanently says "no phone connected" WHILE the phone
// is connected and text is landing in the foreground window. Only an app restart
// recovers it. W9 split it into halves; the one this suite pins is the server's:
//
//   `RoomStore.joinPc` REPLACES the room's PC slot and RETURNS the socket that
//   was in it. Both call sites in pc.handler.ts discarded that value, so the
//   displaced socket was left connected, authenticated and permanently deaf —
//   every frame addressed to the room goes to the new owner, and nothing is ever
//   addressed to it again. W9 experiment (A) measured that state 6/6.
//
// WHY A REAL SERVER AND REAL socket.io CLIENTS: the deliverable is a claim about
// the DISPLACED PEER's state, so it has to be read on the peer, not inferred from
// a fake's `disconnected` counter. `reason === 'io server disconnect'` is the
// client-side proof that the SERVER closed it (socket.io-client socket.js:642) —
// a transport hiccup or a local `.disconnect()` produce different reasons, so this
// assertion cannot be satisfied by the socket merely dying.
//
// ⚠️ Every client here is `reconnection: false`. A real desktop sets
// `reconnect_on_disconnect(true)` (rust_socketio 0.6, client.rs:351), so in the
// field a displaced session comes BACK and re-registers — which is the intended
// recovery, and would make 「did it get closed」 unobservable in this harness.
//
// SPEC-REF: docs/strategy/2026-08-07-w9-window-handoff-report.md §2-2 (the three
//           halves) + §5-3 (why experiment (A) was kept out of golden);
//           apps/server-core/src/socket/handlers/mobile.handler.ts (`joinAndNotify`
//           — the identical treatment of the identical value since GA-26).

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

/** The disconnect REASON the peer was given, or null if it was never closed.
 *  Resolving to null rather than rejecting is deliberate: 「it stayed open」 is the
 *  pre-fix behaviour and has to arrive as a comparable VALUE, so the failure reads
 *  `Expected "io server disconnect" / Received null` instead of a bare timeout. */
function closedWith(socket: ClientSocket, ms = 1200): Promise<string | null> {
  return new Promise((resolve) => {
    if (socket.disconnected) return resolve('already-closed');
    const timer = setTimeout(() => resolve(null), ms);
    socket.once('disconnect', (reason: string) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

/** Poll `pc_devices.is_online` until it reads `want`, then return it; on timeout
 *  return whatever it actually says. Returning the OBSERVED value rather than
 *  throwing is the same choice `closedWith` makes: the failure has to read
 *  `Expected 0 / Received 1`, which names the fact, instead of a bare timeout,
 *  which names only the clock. The disconnect hook runs on the server's own
 *  event loop, so there is no ack to await — this is the seam where a poll is
 *  the honest instrument rather than a lazy one. */
async function onlineFlagSettlesTo(pcId: string, want: 0 | 1, ms = 1200): Promise<0 | 1 | undefined> {
  const deadline = Date.now() + ms;
  let seen = server.db.pcs.findById(pcId)?.is_online;
  while (seen !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    seen = server.db.pcs.findById(pcId)?.is_online;
  }
  return seen;
}

/** One desktop's first contact: no token, register, own the room. */
async function firstSession(instance: string) {
  const sock = await connect();
  const reg = await ack<Record<string, string | undefined>>(sock, 'pc:register', {
    device_name: 'Displacement PC',
    client_instance_id: instance,
  });
  const { pc_id: pcId, token, room_uuid: roomUuid } = reg;
  // Fail on the REGISTRATION rather than three lines later on a mystery
  // `undefined` — a suite about displacement must not be able to report a broken
  // register leg as a displacement failure.
  if (pcId === undefined || token === undefined || roomUuid === undefined) {
    throw new Error(`pc:register failed: ${JSON.stringify(reg)}`);
  }
  return { sock, token, pcId, roomUuid };
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

describe('F-3 Fix#2 — a displaced PC socket is closed, not left deaf', () => {
  it('pc:reconnect from a second socket closes the first', async () => {
    const first = await firstSession('inst-displace-recon-01');
    const closed = closedWith(first.sock);

    const second = await connect({ token: first.token });
    const recon = await ack<Record<string, unknown>>(second, 'pc:reconnect', { token: first.token });
    expect(recon.room_uuid).toBe(first.roomUuid);

    // The peer itself reports WHO closed it. This is the whole card.
    expect(await closed).toBe('io server disconnect');
    // …and the room slot belongs to the newcomer, which is the behaviour W9
    // experiment (A) measured and this card is explicitly NOT changing.
    expect(first.sock.connected).toBe(false);
    expect(second.connected).toBe(true);
  });

  it('pc:register from a second socket closes the first (the OTHER call site)', async () => {
    // Same machine coming back through the register leg — a desktop that cleared
    // its credentials. registerPc recognises client_instance_id, keeps the row,
    // and hands back the SAME room, so the older session is displaced there too.
    // Pinned separately because the fix is one helper called twice: deleting
    // either call site must fail, and a suite that only drove one leg would go
    // green with half the fix removed.
    const first = await firstSession('inst-displace-reg-02');
    const closed = closedWith(first.sock);

    const second = await connect();
    const reg = await ack<Record<string, unknown>>(second, 'pc:register', {
      device_name: 'Displacement PC',
      client_instance_id: 'inst-displace-reg-02',
    });
    expect(reg.room_uuid).toBe(first.roomUuid);
    expect(reg.pc_id).toBe(first.pcId);

    expect(await closed).toBe('io server disconnect');
    expect(second.connected).toBe(true);
  });

  it('🔴 re-registering on the SAME socket is not a displacement — it must survive', async () => {
    // The RV-26 register watchdog re-fires on a live socket, and register→reconnect
    // on one connection is legal. Without the `previous.id === current.id` guard
    // this path kills the very session it just admitted, before the ack is sent —
    // strictly worse than the defect being fixed. The negative control is as
    // load-bearing as the two above.
    const only = await firstSession('inst-displace-same-03');
    const closed = closedWith(only.sock, 400);

    const again = await ack<Record<string, unknown>>(only.sock, 'pc:reconnect', { token: only.token });
    expect(again.room_uuid).toBe(only.roomUuid);

    expect(await closed).toBeNull();
    expect(only.sock.connected).toBe(true);
  });

  // ── the is_online pair. READ THESE TWO TOGETHER; neither one means anything
  //    alone. The gate they guard is `if (store.leavePc(...)) setOnline(false)`
  //    in bootstrap.ts, and it has exactly two ways to be wrong:
  //      · too eager  → a displaced socket marks a LIVE machine offline  (negative)
  //      · too shy    → nobody ever marks a machine offline at all       (positive)
  //    A negative-only suite cannot tell 「the gate is correctly conditioned」 from
  //    「the write never happens」, because both produce the same measured zero —
  //    the G13 rule, verbatim: a negative assertion needs a positive control or the
  //    zero you measured might be a blind probe. The too-shy direction is the
  //    dangerous one to leave unpinned: every symptom of it reads as 「the device is
  //    online」, which is the comfortable-looking answer nobody goes looking behind.
  it('the room owner disconnecting DOES mark the PC offline (positive control)', async () => {
    // The ordinary case, and the one the gate must not have broken: one PC, no
    // displacement anywhere, socket closes normally ⇒ `leavePc` matches on socket_id
    // ⇒ the write fires. This is what /api/cloud/devices and the reaper's staleness
    // gate depend on actually happening.
    const owner = await firstSession('inst-displace-online-05');
    // Not decoration: without proving the row reached 1 first, `toBe(0)` below is
    // satisfied by a column that was NEVER written — the positive control would
    // then have the same blind spot it exists to close.
    expect(server.db.pcs.findById(owner.pcId)?.is_online).toBe(1);

    owner.sock.disconnect();

    expect(await onlineFlagSettlesTo(owner.pcId, 0)).toBe(0);
  });

  it('🔴 the displaced socket must NOT mark the live PC offline', async () => {
    // Both sockets carry the SAME `auth.deviceId` (one pc_devices row), so the
    // displaced socket's disconnect hook was about to write is_online=0 over the
    // registration that had just written 1 — read by /api/cloud/devices and by the
    // reaper's `is_online=0 AND stale` gate. Asserted on the DB row rather than on
    // any surface that renders it: the surfaces are consumers, the row is the fact.
    const first = await firstSession('inst-displace-online-04');
    const closed = closedWith(first.sock);

    const second = await connect({ token: first.token });
    await ack(second, 'pc:reconnect', { token: first.token });
    expect(await closed).toBe('io server disconnect'); // the hook has now run

    expect(server.db.pcs.findById(first.pcId)?.is_online).toBe(1);
  });
});
