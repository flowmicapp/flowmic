// P0 red line (fix-001) — "when the capsule window is up, one and only one phone may be connected".
//
// REPRODUCTION FIRST. This file starts as the failing measurement that the card
// asked for: it walks the LAST segment of the chain, the one the Cursor box's
// real-device forensics could see was broken but could not localise.
//
// What the forensics established (2026-08-11 11:13, timestamps to the ms):
//   · the PC-side verdict RUNS and is CORRECT — `REFUSING <B> — capsule held by
//     <A>` logged 5x, holder named right;
//   · the server RECEIVED and EXECUTED it — `targets:1 / released:1`;
//   · and yet `mobiles=2` persisted for EIGHT MINUTES with no `pc:mobile-left`,
//     both phones sitting on the transcription screen.
//
// `released:1` is a TRUE statement answering a DIFFERENT question. It counts
// 「I found a socket and called disconnect() on it」 (pc.handler.ts:386-390) —
// not 「that phone gave up the capsule」. The gap between those two questions is
// where this defect lives, and it is the repo's #1 shape (one value, two
// questions) for the third time on this wire.
//
// THE MECHANISM (what these tests pin):
//   1. B arrives          → `previous === null` → `pc:mobile-joined` → PC refuses;
//   2. server suppresses B for BUSY_SUPPRESS_MS (8 s) and disconnects its socket;
//   3. the DEAD socket stays in `mobileSockets` — `leaveMobile` is deferred to the
//      end of the GA-04 mobile-drop grace (~30 s), by design;
//   4. B's reconnect ladder returns INSIDE that grace but AFTER the 8 s window ⇒
//      suppression has lapsed, so B is admitted; `joinAndNotify` sees
//      `previous !== null` (the dead socket) ⇒ `isNewPresence === false` ⇒
//      **no `pc:mobile-joined` is emitted** ⇒ the desktop's `Admission` verdict
//      NEVER RUNS AGAIN. B is in the room, on the transcription screen, and the
//      capsule owner has no idea it came back.
//   5. when the grace finally expires, `leaveMobile(room, B, OLD_socket_id)`
//      correctly returns false (GA-26's displaced-socket guard — the slot holds a
//      NEWER socket) ⇒ no `pc:mobile-left` either. Hence eight silent minutes.
//
// ⇒ The defect window is exactly `BUSY_SUPPRESS_MS < gap < mobile_drop_grace`.
//    Outside it the system self-corrects, which is why the forensics show a few
//    REFUSING lines (the gaps that exceeded the grace) rather than none.
//
// 🔴 `isNewPresence` is answering a THIRD question it was never given.
//    joinAndNotify already split `needsFocusSeed` out of it once (bug A-1) and
//    says in as many words 「do not collapse these into one boolean again」. The
//    capsule verdict is the third question: 「may this socket speak into the
//    capsule?」 is not 「is this phone newly present?」 — a socket swap is a NEW
//    ANSWER to the first and an unchanged answer to the second.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1; GA-26 / GA-28 / GA-29;
//           docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §R11

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { ReleaseSuppression, BUSY_SUPPRESS_MS } from '../src/room/release-suppression';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const PC_INSTANCE = 'desktop-instance-aaaa';

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  connected = true;
  disconnected = 0;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();

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
  off(): this { return this; }
  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  disconnect(_close?: boolean): this {
    this.disconnected += 1;
    this.connected = false;
    return this;
  }
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;
let suppression: ReleaseSuppression;
let clock = 1_700_000_000_000;

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: socket.data.auth?.userId ?? 'default' }),
    suppression,
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
    suppression,
    // A2-3 (F1) — the admission gate's reader, pointed at the REAL repo. These
    // fixtures never restrict anyone, so every assertion in this file is about
    // the same behaviour it was before the gate existed. Not optional in the
    // deps on purpose (mobile.handler.ts): a missing reader would turn the gate
    // off with no compile error.
    restriction: { getUser: (id) => db.users.findById(id) },
  });
  return socket;
}

/** A registered PC whose socket is REALLY in the room (`joinPc`), so that
 *  `joinAndNotify`'s `store.getPc(room)?.emit(...)` has somewhere to land. That
 *  is the whole point of this file — the frame the PC does or does not hear. */
function setUpRoom() {
  const { pc } = registry.registerPc({
    device_name: 'dev-pc-a',
    user_id: 'default',
    client_instance_id: PC_INSTANCE,
  });
  const row = registry.findPc(pc.id)!;
  const pcSock = wirePc(new FakeSocket('sock-pc', {
    auth: { userId: 'default', deviceId: row.id, kind: 'pc' },
    roomUuid: row.room_uuid,
  }));
  store.joinPc(row.room_uuid, pcSock as unknown as Socket);
  return { pc: row, pcSock };
}

function pairPhone(shortCode: string, name: string) {
  return registry.pairMobile({ short_code: shortCode, mobile_name: name, user_id: 'default' });
}

/** Every `pc:mobile-joined` the desktop heard for one phone. This count IS the
 *  number of times the capsule verdict got a chance to run — presence.rs invokes
 *  `Admission::join` from that handler and from nowhere else (no pull, no poll). */
function joinFramesFor(pcSock: FakeSocket, mobileId: string): unknown[] {
  return pcSock.emitted
    .filter((e) => e.event === 'pc:mobile-joined')
    .filter((e) => (e.payload as { mobile_id?: string } | null)?.mobile_id === mobileId)
    .map((e) => e.payload);
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, now: () => clock });
  store = new RoomStore<Socket>();
  suppression = new ReleaseSuppression(() => clock);
});
afterEach(() => db.close());

describe('P0 red line — the capsule verdict must run for EVERY socket that takes the room slot', () => {
  it('re-announces a phone that returns on a new socket inside the GA-04 grace', async () => {
    // ── the owner's scene: phone A holds the capsule, phone B wants in ──────
    const { pc, pcSock } = setUpRoom();
    const phoneA = pairPhone(pc.short_code, 'Lenovo TB335ZC');
    const phoneB = pairPhone(pc.short_code, 'HUAWEI ELE-AL00');

    // A is already in the room and speaking — it owns the capsule.
    const sockA = new FakeSocket('sock-a');
    store.joinMobile(pc.room_uuid, phoneA.mobile.id, sockA as unknown as Socket);

    // ── ① B arrives for the first time: the PC IS told, and refuses ─────────
    const sockB1 = wireMobile(new FakeSocket('sock-b-1'));
    const firstJoin = await sockB1.invoke('mobile:reconnect', { token: phoneB.token });
    expect(firstJoin.error).toBeUndefined();
    expect(joinFramesFor(pcSock, phoneB.mobile.id)).toHaveLength(1);

    // The desktop's Admission refuses and the PC sends the busy release. (In
    // production presence.rs emits this; here the PC socket drives the same
    // handler over the same wire name — the server cannot tell the difference.)
    const refusal = await pcSock.invoke('pc:release-mobile', {
      mobile_id: phoneB.mobile.id,
      reason: 'busy',
    });
    // The ack the forensics saw. Both halves are TRUE — and neither one answers
    // 「did B give up the capsule?」.
    expect(refusal).toMatchObject({ ok: true, released: 1, revoked: 0, suppressed_ms: BUSY_SUPPRESS_MS });
    expect(sockB1.disconnected).toBe(1);

    // ── ② the dead socket LINGERS in the slot ──────────────────────────────
    // GA-04 defers `leaveMobile` to the end of the mobile-drop grace, so for the
    // next ~30 s the room still maps B → the socket that was just killed. This
    // is deliberate and is NOT the bug; it is the precondition for it.
    const lingering = store.getMobile(pc.room_uuid, phoneB.mobile.id);
    expect(lingering).toBe(sockB1 as unknown as Socket);
    expect(lingering?.connected).toBe(false);

    // ── ③ B's ladder returns after the 8 s hold-out but INSIDE the grace ────
    clock += BUSY_SUPPRESS_MS + 1;
    const sockB2 = wireMobile(new FakeSocket('sock-b-2'));
    const secondJoin = await sockB2.invoke('mobile:reconnect', { token: phoneB.token });

    // The server admits it — correctly, on its own terms. The server is not the
    // judge of who holds the capsule (that is the desktop's call by design), and
    // the busy window has honestly lapsed.
    expect(secondJoin.error).toBeUndefined();
    expect(store.getMobile(pc.room_uuid, phoneB.mobile.id)).toBe(sockB2 as unknown as Socket);

    // ── ④ THE DEFECT ───────────────────────────────────────────────────────
    // B is back in the room on a live socket. The capsule is still A's. The one
    // thing that could refuse B is the desktop verdict, and the ONLY trigger for
    // that verdict is this frame. Without a second one, B squats silently — which
    // is exactly the eight minutes of `mobiles=2` the forensics recorded.
    expect(joinFramesFor(pcSock, phoneB.mobile.id)).toHaveLength(2);
  });

  it('a genuine first arrival is still announced exactly once (no double-fire)', async () => {
    // Guards the fix from the opposite failure: re-announcing must not turn one
    // arrival into two, or the desktop would refuse a phone it just granted.
    const { pc, pcSock } = setUpRoom();
    const phone = pairPhone(pc.short_code, 'Pixel 9');

    const sock = wireMobile(new FakeSocket('sock-only'));
    await sock.invoke('mobile:reconnect', { token: phone.token });

    expect(joinFramesFor(pcSock, phone.mobile.id)).toHaveLength(1);
  });

  it('the re-announced frame carries the SAME shape as a first arrival', async () => {
    // The desktop parses `mobile_id` out of this frame (wire::parse_mobile_id) and
    // ignores frames it cannot attribute. A re-announcement that dropped the id
    // would be recorded as 「pc:mobile-joined without mobile_id — ignored」 and the
    // verdict would be skipped just as silently as before. Same shape, or the fix
    // is a façade.
    const { pc, pcSock } = setUpRoom();
    const phoneA = pairPhone(pc.short_code, 'Holder');
    const phoneB = pairPhone(pc.short_code, 'Second');
    store.joinMobile(pc.room_uuid, phoneA.mobile.id, new FakeSocket('sock-a') as unknown as Socket);

    const b1 = wireMobile(new FakeSocket('sock-b-1'));
    await b1.invoke('mobile:reconnect', { token: phoneB.token });
    await pcSock.invoke('pc:release-mobile', { mobile_id: phoneB.mobile.id, reason: 'busy' });

    clock += BUSY_SUPPRESS_MS + 1;
    const b2 = wireMobile(new FakeSocket('sock-b-2'));
    await b2.invoke('mobile:reconnect', { token: phoneB.token });

    const frames = joinFramesFor(pcSock, phoneB.mobile.id);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual(frames[0]);
  });
});
