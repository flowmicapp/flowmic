// GA-07 + GA-26 — "presence truth": the server side of "how many phones are here".
//
// The owner reproduced a desktop showing 2 phones with 1 phone on the LAN. Three
// causes stacked; two of them are server-side and pinned here against the REAL
// handlers over a REAL sqlite db + REAL Registry + REAL RoomStore (fakes only at
// the socket seam):
//
//   ① REPLACEMENT IS NOT AN ARRIVAL (GA-26) — `store.joinMobile` REPLACES the
//      socket under a pairing id. Re-announcing `pc:mobile-joined` on every
//      reconnect of the SAME phone is what fed the desktop's phantom +1. N
//      reconnects ⇒ exactly ONE joined.
//   ② connectedMobiles IS PROVEN, NOT REMEMBERED (GA-07) — pc:reconnect pings
//      every candidate; a zombie that cannot pong is evicted from the store,
//      disconnected, and left out of the ack. A live phone that pongs is kept.
//   ③ heartbeat IS CONSUMED (GA-07) — it moves last_seen_at, so the device
//      page's "recent activity" stops being frozen at pairing time.
//
// NO REAL SLEEP: the probe's budget and timer are injected (`liveness` dep), so
// the zombie path fires the deadline on demand.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1/§3.2;
//           docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-07/GA-26

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { registerHeartbeatHandler } from '../src/socket/handlers/heartbeat.handler';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

/** ClientInstanceId is `min(16)` — a short 'inst-a' is a payload rejection. */
const PC_INSTANCE = 'desktop-instance-aaaa';

interface Emitted {
  event: string;
  payload: unknown;
}

/** A socket fake with just enough surface for the handlers AND the probe:
 *  emit/on/off/once + disconnect. `pong` controls whether it answers sys:ping —
 *  that single flag is the difference between a live phone and a zombie. */
class FakeSocket {
  readonly emitted: Emitted[] = [];
  connected = true;
  disconnected = 0;
  /** null → never answers (the force-stopped phone). */
  pongNonce: 'echo' | 'wrong' | null = 'echo';
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();

  /** mobile.handler buckets the pair rate limiter per client IP. */
  readonly handshake = { address: '10.0.0.9' };

  constructor(
    readonly id: string,
    public data: { auth: AuthContext | null; roomUuid?: string } = { auth: null },
  ) {}

  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, fn: (payload: unknown) => void): this {
    const list = (this.handlers.get(event) ?? []).filter((f) => f !== fn);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    // The client half: a live phone answers sys:ping with the SAME nonce.
    if (event === 'sys:ping' && this.pongNonce !== null) {
      const nonce = (payload as { nonce: string }).nonce;
      this.deliver('sys:pong', { nonce: this.pongNonce === 'echo' ? nonce : `${nonce}-tampered`, ok: true });
    }
    return true;
  }

  disconnect(_close?: boolean): this {
    this.disconnected += 1;
    this.connected = false;
    return this;
  }

  /** Drive an inbound event into the registered handlers. */
  deliver(event: string, payload: unknown, ack?: (r: unknown) => void): void {
    for (const fn of this.handlers.get(event) ?? []) fn(payload, ack);
  }

  /** Drive an inbound event and resolve with its ack payload. */
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      this.deliver(event, payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }

  events(name: string): unknown[] {
    return this.emitted.filter((e) => e.event === name).map((e) => e.payload);
  }
}

/** Timer seam: nothing fires until the test says so — no real 1.5 s anywhere. */
class ManualTimers {
  private pending: (() => void)[] = [];
  readonly setTimer = (fn: () => void): unknown => {
    this.pending.push(fn);
    return this.pending.length - 1;
  };
  readonly clearTimer = (h: unknown): void => {
    const i = h as number;
    if (typeof i === 'number' && this.pending[i]) this.pending[i] = (): void => {};
  };
  /** Expire every armed deadline (the 1.5 s budget elapsing). */
  fire(): void {
    const due = this.pending;
    this.pending = [];
    for (const fn of due) fn();
  }
}

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;
let timers: ManualTimers;

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: socket.data.auth?.userId ?? 'default' }),
    liveness: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
  });
  return socket;
}

function wireMobile(socket: FakeSocket): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    resolveActingUser: () => ({ userId: 'default' }),
    // A2-3 (F1) — the admission gate's reader, pointed at the REAL repo. Nobody
    // is restricted here, so presence/liveness is measured unchanged. Not
    // optional in the deps on purpose (mobile.handler.ts).
    restriction: { getUser: (id) => db.users.findById(id) },
  });
  return socket;
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
  timers = new ManualTimers();
});
afterEach(() => db.close());

/** Register a PC through the REAL handler and park its socket in the room. */
async function registerPc(): Promise<{ sock: FakeSocket; pcId: string; roomUuid: string; shortCode: string; token: string }> {
  const sock = wirePc(new FakeSocket('s-pc'));
  const ack = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: PC_INSTANCE });
  if (ack.pc_id === undefined) throw new Error(`pc:register failed: ${JSON.stringify(ack)}`);
  return {
    sock,
    pcId: ack.pc_id as string,
    roomUuid: ack.room_uuid as string,
    shortCode: ack.short_code as string,
    token: ack.token as string,
  };
}

describe('GA-26 — a phone that reconnects is not a second phone', () => {
  // 🔴 REWRITTEN BY fix-001 (P0 red line "the capsule may only have one phone"). This test used to read
  // "N reconnects produce exactly ONE pc:mobile-joined" and assert
  // `toHaveLength(1)` on the frames. That assertion pinned GA-26's MECHANISM, not
  // its REQUIREMENT — and the mechanism was load-bearing for a defect:
  //
  //   suppressing the announce on a socket swap is the reason a busy-REFUSED
  //   second phone could return inside the GA-04 grace and squat on the capsule
  //   forever, because `Admission::join` is reachable from `pc:mobile-joined` and
  //   from nowhere else. Real-device forensics: `mobiles=2` for eight minutes.
  //
  // GA-26's requirement is what owner actually reported — "online phones" count inflated, 2
  // phones shown for 1 phone — and that is a statement about the presence SET,
  // asserted below and UNCHANGED. The desktop upholds it by identity
  // (`Reconciler::on_join` is an idempotent insert into a HashSet; GA-26's own
  // header calls out "a duplicate joined (server re-announced a reconnecting
  // phone)" as harmless BY CONSTRUCTION). Counting frames was a second, weaker
  // copy of that rule — and the two copies disagreed the day the red line arrived.
  //
  // ⚠️ This is the shape CLAUDE.md names outright: a reverse control that picked the wrong direction is worse than no reverse
  // control — it writes the defect into the acceptance criteria, and when the fix arrives it goes red, making people think the fix
  // is wrong. If you are reading this because it went red again: check whether you
  // changed WHO the frames are about, not how many there are.
  it('① N reconnects of the SAME pairing stay ONE phone, and re-arm the capsule verdict', async () => {
    const pc = await registerPc();
    const first = wireMobile(new FakeSocket('m-1'));
    const pairAck = await first.invoke('mobile:pair', { short_code: pc.shortCode });
    const mobileToken = pairAck.mobile_token as string;
    const pairingId = pairAck.pairing_id as string;

    expect(pc.sock.events('pc:mobile-joined')).toHaveLength(1);

    // Five reconnects, each on a FRESH socket (what a phone actually does).
    for (let i = 2; i <= 6; i += 1) {
      const s = wireMobile(new FakeSocket(`m-${i}`));
      const ack = await s.invoke('mobile:reconnect', { token: mobileToken });
      expect(ack.pairing_id).toBe(pairingId);
    }

    // Every socket that TOOK THE SLOT announced itself, so the capsule verdict got
    // a chance to run each time (fix-001). Six sockets ⇒ six frames.
    const frames = pc.sock.events('pc:mobile-joined');
    expect(frames).toHaveLength(6);
    // 🔴 GA-26's REQUIREMENT, and the reason six frames cannot inflate anything:
    // every one of them is about the SAME pairing. An identity-keyed consumer sees
    // one phone; only a COUNTER could read six — and deleting that counter was
    // GA-26's actual fix.
    expect(new Set(frames.map((f) => (f as { mobile_id: string }).mobile_id))).toEqual(new Set([pairingId]));
    // …and the room still holds exactly one phone, under the newest socket.
    expect(store.snapshot(pc.roomUuid)?.mobile_ids).toEqual([pairingId]);
    expect((store.getMobile(pc.roomUuid, pairingId) as unknown as FakeSocket).id).toBe('m-6');
  });

  it('① REVERSE CONTROL — a re-announce is never a SECOND identity', async () => {
    // The failure the frame-count assertion used to stand in for. If a swap ever
    // announced under a different id (a socket id, a device_uid, a fresh pairing),
    // the desktop's SET would grow and owner's original 「2 phones with 1 phone」
    // would be back — this time invisible to the count assertion above, which only
    // reads the room. Asserted on the WIRE, where the desktop reads it.
    const pc = await registerPc();
    const first = wireMobile(new FakeSocket('m-1'));
    const pairAck = await first.invoke('mobile:pair', { short_code: pc.shortCode });
    const pairingId = pairAck.pairing_id as string;

    const again = wireMobile(new FakeSocket('m-2'));
    await again.invoke('mobile:reconnect', { token: pairAck.mobile_token as string });

    const frames = pc.sock.events('pc:mobile-joined') as { mobile_id: string; mobile_name: string; room_uuid: string }[];
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual(frames[0]);
    expect(frames[1]!.mobile_id).toBe(pairingId);
  });

  // A-1: a same-pairing reconnect still needs a focus:state seed on the NEW socket
  // — gating that seed on `previous === null` answered it with the presence
  // question's answer, and left the phone's destination as `—` for whole sessions.
  //
  // 🔴 fix-001 amended the second half of this test's original name («WITHOUT a
  // second mobile-joined»). That clause described the sibling question's answer at
  // the time, and it has since changed: a socket swap now DOES announce, because
  // the capsule verdict is a third question that must run for every socket taking
  // the slot (see mobile.handler.ts joinAndNotify). A-1's own point is untouched
  // and is what the focus assertion below pins — the two questions are still
  // decided separately, which is the whole lesson. They simply both answer «yes»
  // for this input now, and a test that reads one off the other would be making
  // A-1's mistake in the opposite direction.
  it('A-1: reconnect seeds focus:state on the new socket, decided independently', async () => {
    const pc = await registerPc();
    registerRelayHandlers(pc.sock as unknown as Socket, { store });
    const FOCUS = { window_title: 'flowmic-app - Cursor', process_name: 'Cursor' };
    pc.sock.deliver('focus:state', FOCUS);
    expect(store.getLastFocus(pc.roomUuid)).toEqual(FOCUS);

    const first = wireMobile(new FakeSocket('m-1'));
    const pairAck = await first.invoke('mobile:pair', { short_code: pc.shortCode });
    const mobileToken = pairAck.mobile_token as string;
    expect(pc.sock.events('pc:mobile-joined')).toHaveLength(1);
    expect(first.events('focus:state')).toEqual([FOCUS]);

    // Silent reconnect: old socket still in the store (EMUI / WiFi↔4G — leave
    // never ran), so joinMobile returns previous !== null.
    const again = wireMobile(new FakeSocket('m-2'));
    const ack = await again.invoke('mobile:reconnect', { token: mobileToken });
    expect(ack.pairing_id).toBe(pairAck.pairing_id);

    // A-1's load-bearing assertion: the seed reached the NEW socket.
    expect(again.events('focus:state')).toEqual([FOCUS]);
    // The sibling question, answered on its own terms (fix-001): the swap is
    // announced so the capsule verdict re-runs, under the SAME identity.
    const frames = pc.sock.events('pc:mobile-joined') as { mobile_id: string }[];
    expect(frames).toHaveLength(2);
    expect(frames[1]!.mobile_id).toBe(pairAck.pairing_id);
  });

  it('the DISPLACED socket is dropped, so one pairing never holds two live links', async () => {
    const pc = await registerPc();
    const first = wireMobile(new FakeSocket('m-1'));
    const token = (await first.invoke('mobile:pair', { short_code: pc.shortCode })).mobile_token as string;
    expect(first.disconnected).toBe(0);

    const second = wireMobile(new FakeSocket('m-2'));
    await second.invoke('mobile:reconnect', { token });

    expect(first.disconnected).toBe(1);
    expect(second.disconnected).toBe(0);
  });

  it('a DIFFERENT phone still announces itself — the suppression is per pairing', async () => {
    const pc = await registerPc();
    const a = wireMobile(new FakeSocket('m-a'));
    await a.invoke('mobile:pair', { short_code: pc.shortCode });
    const b = wireMobile(new FakeSocket('m-b'));
    await b.invoke('mobile:pair', { short_code: pc.shortCode });

    const joined = pc.sock.events('pc:mobile-joined') as { mobile_id: string }[];
    expect(joined).toHaveLength(2);
    expect(new Set(joined.map((j) => j.mobile_id)).size).toBe(2);
  });
});

describe('GA-07 — pc:reconnect ack.connectedMobiles is liveness-CONFIRMED', () => {
  async function roomWith(pongs: ('echo' | 'wrong' | null)[]): Promise<{
    pc: Awaited<ReturnType<typeof registerPc>>;
    mobiles: { sock: FakeSocket; pairingId: string }[];
  }> {
    const pc = await registerPc();
    const mobiles = [];
    for (let i = 0; i < pongs.length; i += 1) {
      const sock = wireMobile(new FakeSocket(`m-${i}`));
      const ack = await sock.invoke('mobile:pair', { short_code: pc.shortCode });
      sock.pongNonce = pongs[i]!;
      mobiles.push({ sock, pairingId: ack.pairing_id as string });
      // Each pair mints a NEW pairing, so refresh the code for the next phone.
      if (i + 1 < pongs.length) await pc.sock.invoke('pc:refresh-code', {});
      if (i + 1 < pongs.length) pc.shortCode = registry.findPc(pc.pcId)!.short_code;
    }
    return { pc, mobiles };
  }

  it('② a zombie that never pongs is excluded from the ack, evicted and disconnected', async () => {
    const { pc, mobiles } = await roomWith([null]);
    const zombie = mobiles[0]!;
    // Pre-condition: the raw store snapshot — the OLD ack source — still lists it.
    expect(store.snapshot(pc.roomUuid)?.mobile_ids).toEqual([zombie.pairingId]);

    const reconnecting = wirePc(new FakeSocket('s-pc-2'));
    const ackP = reconnecting.invoke('pc:reconnect', { token: pc.token, client_instance_id: PC_INSTANCE });
    timers.fire(); // the 1.5 s budget elapses with no pong
    const ack = await ackP;

    expect(ack.connectedMobiles).toEqual([]);
    expect(store.getMobile(pc.roomUuid, zombie.pairingId)).toBeNull();
    expect(zombie.sock.disconnected).toBe(1);
    expect(zombie.sock.events('sys:ping')).toHaveLength(1);
  });

  it('③ a live phone that pongs is counted, and no timeout is needed', async () => {
    const { pc, mobiles } = await roomWith(['echo']);
    const live = mobiles[0]!;

    const reconnecting = wirePc(new FakeSocket('s-pc-2'));
    // NOTE: no timers.fire() — the probe resolves the moment every pong is in.
    const ack = await reconnecting.invoke('pc:reconnect', { token: pc.token, client_instance_id: PC_INSTANCE });

    expect(ack.connectedMobiles).toEqual([live.pairingId]);
    expect(store.getMobile(pc.roomUuid, live.pairingId)).not.toBeNull();
    expect(live.sock.disconnected).toBe(0);
  });

  it('a mixed room keeps only the prover', async () => {
    const { pc, mobiles } = await roomWith(['echo', null]);
    const [live, dead] = mobiles as [{ sock: FakeSocket; pairingId: string }, { sock: FakeSocket; pairingId: string }];

    const reconnecting = wirePc(new FakeSocket('s-pc-2'));
    const ackP = reconnecting.invoke('pc:reconnect', { token: pc.token, client_instance_id: PC_INSTANCE });
    timers.fire();
    const ack = await ackP;

    expect(ack.connectedMobiles).toEqual([live.pairingId]);
    expect(store.getMobile(pc.roomUuid, dead.pairingId)).toBeNull();
    expect(store.getMobile(pc.roomUuid, live.pairingId)).not.toBeNull();
  });

  it('a pong with the WRONG nonce is not proof — the socket is treated as dead', async () => {
    const { pc, mobiles } = await roomWith(['wrong']);
    const liar = mobiles[0]!;

    const reconnecting = wirePc(new FakeSocket('s-pc-2'));
    const ackP = reconnecting.invoke('pc:reconnect', { token: pc.token, client_instance_id: PC_INSTANCE });
    timers.fire();
    const ack = await ackP;

    expect(ack.connectedMobiles).toEqual([]);
    expect(liar.sock.disconnected).toBe(1);
  });

  it('an empty room acks immediately with an empty roster (no probe, no timer)', async () => {
    const pc = await registerPc();
    const reconnecting = wirePc(new FakeSocket('s-pc-2'));
    const ack = await reconnecting.invoke('pc:reconnect', { token: pc.token, client_instance_id: PC_INSTANCE });
    expect(ack.connectedMobiles).toEqual([]);
    expect(ack.pc_id).toBe(pc.pcId);
  });
});

describe('RV-08 — the pc:register ack carries the roster too', () => {
  // The leg GA-26 forgot. A desktop that cleared its credentials (or was
  // reinstalled) has no token, so it comes back through pc:register — while
  // registerPc recognises the machine and keeps its EXISTING row and room, with
  // the phones still in it. An ack without `connectedMobiles` left the desktop at
  // mobile_count 0, so `server_ready` never opened and focus:state was never
  // mirrored: the tray said 0 phones with a phone sitting in the room.
  const PC_MACHINE_UID = 'pc-1f3a5c7e9b2d4f60';

  /** Register through the REAL handler, carrying a machine uid (v0.2.4). */
  async function registerMachine(
    instanceId: string,
  ): Promise<{ sock: FakeSocket; ack: Record<string, unknown> }> {
    const sock = wirePc(new FakeSocket(`s-pc-${instanceId}`));
    const ack = await sock.invoke('pc:register', {
      device_name: 'PC-A',
      client_instance_id: instanceId,
      machine_uid: PC_MACHINE_UID,
    });
    return { sock, ack };
  }

  it('a REINSTALLED desktop (new instance id, same machine) is seeded with the '
    + 'phone that is still in its room', async () => {
    const first = await registerMachine(PC_INSTANCE);
    const phone = wireMobile(new FakeSocket('m-1'));
    const pairingId = (
      await phone.invoke('mobile:pair', { short_code: first.ack.short_code as string })
    ).pairing_id as string;

    // The reinstall: brand-new client_instance_id, same physical machine → the
    // registry resolves the EXISTING row through machine_uid (② in registerPc).
    const again = await registerMachine('desktop-instance-bbbbbb');

    expect(again.ack.room_uuid).toBe(first.ack.room_uuid);
    expect(again.ack.connectedMobiles).toEqual([pairingId]);
    // A live phone is proven, not evicted — the probe answered, nothing was killed.
    expect(phone.events('sys:ping')).toHaveLength(1);
    expect(phone.disconnected).toBe(0);
    expect(store.getMobile(first.ack.room_uuid as string, pairingId)).not.toBeNull();
  });

  it('the register leg is liveness-CONFIRMED, not a store snapshot: a zombie is '
    + 'excluded, evicted and disconnected', async () => {
    const first = await registerMachine(PC_INSTANCE);
    const zombie = wireMobile(new FakeSocket('m-z'));
    const pairingId = (
      await zombie.invoke('mobile:pair', { short_code: first.ack.short_code as string })
    ).pairing_id as string;
    zombie.pongNonce = null; // force-stopped: never answers
    const roomUuid = first.ack.room_uuid as string;
    // Pre-condition: the raw snapshot — the tempting ack source — still lists it.
    expect(store.snapshot(roomUuid)?.mobile_ids).toEqual([pairingId]);

    const sock = wirePc(new FakeSocket('s-pc-2'));
    const ackP = sock.invoke('pc:register', {
      device_name: 'PC-A',
      client_instance_id: 'desktop-instance-cccccc',
      machine_uid: PC_MACHINE_UID,
    });
    timers.fire(); // the 1.5 s budget elapses with no pong
    const ack = await ackP;

    expect(ack.room_uuid).toBe(roomUuid);
    expect(ack.connectedMobiles).toEqual([]);
    expect(store.getMobile(roomUuid, pairingId)).toBeNull();
    expect(zombie.disconnected).toBe(1);
  });

  it('an existing room with no phones acks an HONEST EMPTY roster — the field is '
    + 'there and says zero, it does not go missing', async () => {
    const first = await registerMachine(PC_INSTANCE);
    const again = await registerMachine('desktop-instance-dddddd');

    expect(again.ack.room_uuid).toBe(first.ack.room_uuid);
    expect(again.ack).toHaveProperty('connectedMobiles');
    expect(again.ack.connectedMobiles).toEqual([]);
  });

  it('a brand-new register is unchanged: token/room/short_code/expires_in_ms as '
    + 'before, roster honestly empty, no timer needed', async () => {
    const sock = wirePc(new FakeSocket('s-pc-new'));
    // NOTE: no timers.fire() — an empty room short-circuits the probe, so a
    // first-ever registration is not delayed by one tick of liveness budget.
    const ack = await sock.invoke('pc:register', { device_name: 'PC-NEW', client_instance_id: PC_INSTANCE });

    expect(typeof ack.token).toBe('string');
    expect(ack.pc_id).toBe(registry.findPc(ack.pc_id as string)!.id);
    expect(ack.short_code).toBe(registry.findPc(ack.pc_id as string)!.short_code);
    expect(ack.room_uuid).toBe(registry.findPc(ack.pc_id as string)!.room_uuid);
    expect(typeof ack.expires_in_ms).toBe('number');
    expect(ack.expires_in_ms as number).toBeGreaterThan(0);
    expect(ack.connectedMobiles).toEqual([]);
  });
});

describe('GA-07 — heartbeat is consumed: last_seen_at advances', () => {
  it('④ a mobile heartbeat moves ITS pairing row, and only that row', async () => {
    const pc = await registerPc();
    const phone = wireMobile(new FakeSocket('m-1'));
    const pairingId = (await phone.invoke('mobile:pair', { short_code: pc.shortCode })).pairing_id as string;

    // Freshly paired: never heard from (pair does not stamp it).
    expect(db.mobiles.findById(pairingId)!.last_seen_at).toBeNull();

    const t1 = new Date('2026-07-25T10:00:00.000Z');
    registerHeartbeatHandler(phone as unknown as Socket, { pcs: db.pcs, mobiles: db.mobiles, now: () => t1 });
    phone.data.auth = { userId: 'default', deviceId: pc.pcId, pairingId, kind: 'mobile' };
    expect(await phone.invoke('heartbeat', { ts: 1 })).toEqual({ ok: true, last_seen_at: t1.toISOString() });
    expect(db.mobiles.findById(pairingId)!.last_seen_at).toBe(t1.toISOString());

    // …and it advances again on the next beat (not a one-shot stamp).
    const t2 = new Date('2026-07-25T10:00:05.000Z');
    const later = new FakeSocket('m-1b', { auth: phone.data.auth });
    registerHeartbeatHandler(later as unknown as Socket, { pcs: db.pcs, mobiles: db.mobiles, now: () => t2 });
    await later.invoke('heartbeat', { ts: 2 });
    expect(db.mobiles.findById(pairingId)!.last_seen_at).toBe(t2.toISOString());
  });

  it('a PC heartbeat moves pc_devices.last_seen_at WITHOUT flipping is_online', async () => {
    const pc = await registerPc();
    db.pcs.setOnline(pc.pcId, false); // e.g. mid-reconnect bookkeeping
    const t = new Date('2026-07-25T11:00:00.000Z');
    const sock = new FakeSocket('s-pc-hb', { auth: { userId: 'default', deviceId: pc.pcId, kind: 'pc' } });
    registerHeartbeatHandler(sock as unknown as Socket, { pcs: db.pcs, mobiles: db.mobiles, now: () => t });

    await sock.invoke('heartbeat', { ts: 7 });

    const row = db.pcs.findById(pc.pcId)!;
    expect(row.last_seen_at).toBe(t.toISOString());
    expect(row.is_online).toBe(0); // heartbeat proves activity, not a transition
  });

  it('the device page reads the advanced value (pc:list-mobiles "recent activity")', async () => {
    const pc = await registerPc();
    const phone = wireMobile(new FakeSocket('m-1'));
    const pairingId = (await phone.invoke('mobile:pair', { short_code: pc.shortCode })).pairing_id as string;
    const t = new Date('2026-07-25T12:34:56.000Z');
    phone.data.auth = { userId: 'default', deviceId: pc.pcId, pairingId, kind: 'mobile' };
    registerHeartbeatHandler(phone as unknown as Socket, { pcs: db.pcs, mobiles: db.mobiles, now: () => t });
    await phone.invoke('heartbeat', { ts: 3 });

    const listed = (await pc.sock.invoke('pc:list-mobiles', {})).mobiles as { last_seen_at: string }[];
    expect(listed[0]!.last_seen_at).toBe(t.toISOString());
  });

  it('refuses an unidentified socket and a malformed payload — never a silent drop', async () => {
    const anon = new FakeSocket('s-anon');
    registerHeartbeatHandler(anon as unknown as Socket, { pcs: db.pcs, mobiles: db.mobiles });
    expect(await anon.invoke('heartbeat', { ts: 1 })).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(await anon.invoke('heartbeat', { nope: true })).toEqual({ error: 'PAIR_INVALID_PAYLOAD' });
  });
});

describe('the departure half — a phantom pc:mobile-left cannot delete a live phone', () => {
  // The bootstrap disconnect hook emits pc:mobile-left ONLY when leaveMobile
  // actually removed THIS socket. Pinned at the store level (the hook's own
  // discriminator) because a displaced socket's late disconnect is precisely the
  // frame that, combined with a set-based desktop, would erase a live phone.
  it('leaveMobile refuses to remove a pairing held by a DIFFERENT socket', async () => {
    const pc = await registerPc();
    const first = wireMobile(new FakeSocket('m-1'));
    const token = (await first.invoke('mobile:pair', { short_code: pc.shortCode })).mobile_token as string;
    const second = wireMobile(new FakeSocket('m-2'));
    const pairingId = (await second.invoke('mobile:reconnect', { token })).pairing_id as string;

    // The displaced socket's disconnect arrives late → no removal → no emit.
    expect(store.leaveMobile(pc.roomUuid, pairingId, 'm-1')).toBe(false);
    expect(store.getMobile(pc.roomUuid, pairingId)).not.toBeNull();
    // The socket that really holds it does remove it.
    expect(store.leaveMobile(pc.roomUuid, pairingId, 'm-2')).toBe(true);
  });
});
