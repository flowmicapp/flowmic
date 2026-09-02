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
// THE MECHANISM AS ORIGINALLY FIXED (2026-08-11, preserved as history — see the
// 2026-09-02 correction block below for what changed):
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
// 🔴🔴 ORIGINAL DESIGN STATEMENT, NOW SUPERSEDED (kept verbatim, corrected below
// rather than deleted): the first version of these tests asserted, in so many
// words, "The server admits it — correctly, on its own terms. The server is
// not the judge of who holds the capsule (that is the desktop's call by
// design), and the busy window has honestly lapsed." That sentence was true on
// 2026-08-11 and is false today.
//
// ── CORRECTION (2026-09-02, WP-6, A12/F2-b) ─────────────────────────────────
//
// The mechanism above (steps 1-5) required the SERVER to admit a second phone
// FIRST and rely on the PC to notice and evict it SECOND. `findings-crossend-
// main.md` F2-b named the consequence this repo had not yet measured: on a
// replica, before WP-6's generic handoff existed, step 2's `pc:release-mobile`
// call was ITSELF refused (`NODE_IS_REPLICA`) — so the suppression in step 2
// was never built, B was never disconnected, and B stayed in the room
// INDEFINITELY, with every one of its mirrored frames answering
// `INJECT_NOT_PRIMARY` and no banner ever explaining why. The corpse-squatting
// window this file was built to catch (step 4) is a NARROWER instance of the
// same root cause: "the server admits contention and waits for the PC to
// resolve it" has more than one way to leave a second phone stuck in the room.
//
// `mobile.handler.ts`'s `liveContender` (moved to `mobile-room-admission.ts`
// at the file-size cap) closes this at the root: `mobile:pair` and
// `mobile:reconnect` now ask the ROSTER — which they have always had — before
// EITHER verb ever calls `joinAndNotify`. A second, DIFFERENT pairing is
// refused `PC_BUSY` at that call, with a FRESH `retry_after_ms`, and never
// enters `mobileSockets` at all. There is no `pc:mobile-joined` to fire, so
// there is nothing for the desktop's `Admission` FSM to refuse, no
// `pc:release-mobile` round trip to depend on, no corpse, and no GA-04 grace
// window for one to hide in — steps 1-5 above describe a class of defect this
// design change makes structurally unreachable for a genuinely new second
// phone, rather than a scenario these tests still need to keep green by
// simulation.
//
// WHAT DID NOT CHANGE: `joinAndNotify` itself, and the SAME-pairing swap it
// exists to get right (A-1's own scenario — one phone's own ladder returning
// on a new socket) — that mechanism is untouched and is pinned separately in
// `presence-liveness.test.ts` ("A-1: reconnect seeds focus:state on the new
// socket"). `pc:release-mobile{reason:'busy'}` also still exists and still
// works exactly as before — the PC may still actively evict its current
// holder to make room for someone else; what changed is that a SECOND phone
// no longer has to be admitted, announced and evicted just to find that out.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1; GA-26 / GA-28 / GA-29;
//           docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §R11;
//           docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md
//             §3-B F2-b, §5-4 item 3

import { NODE_CAN_WRITE } from '../src/node/writer-only';
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
  registerPcHandlers(socket as unknown as Socket, { writerOnly: NODE_CAN_WRITE,
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: socket.data.auth?.userId ?? 'default' }),
    suppression,
  });
  return socket;
}

function wireMobile(socket: FakeSocket): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, { writerOnly: NODE_CAN_WRITE,
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

describe('A12/F2-b — a second, DIFFERENT phone is refused before it ever occupies the room', () => {
  it('is refused PC_BUSY on its FIRST attempt, hears no error twice, and never joins', async () => {
    // ── the owner's scene: phone A holds the capsule, phone B wants in ──────
    const { pc, pcSock } = setUpRoom();
    const phoneA = pairPhone(pc.short_code, 'Lenovo TB335ZC');
    const phoneB = pairPhone(pc.short_code, 'HUAWEI ELE-AL00');

    // A is already in the room and speaking — it owns the capsule.
    const sockA = new FakeSocket('sock-a');
    store.joinMobile(pc.room_uuid, phoneA.mobile.id, sockA as unknown as Socket);

    // ── B's FIRST attempt is refused at the wire, before any join ───────────
    const sockB1 = wireMobile(new FakeSocket('sock-b-1'));
    const firstJoin = await sockB1.invoke('mobile:reconnect', { token: phoneB.token });

    expect(firstJoin).toMatchObject({ error: 'PC_BUSY', retryable: true, retry_after_ms: BUSY_SUPPRESS_MS });
    // 🔴 THE STRUCTURAL FIX: the PC never hears about B at all. There is no
    // verdict for the desktop to run, correctly or otherwise — the question
    // never reaches it.
    expect(joinFramesFor(pcSock, phoneB.mobile.id)).toHaveLength(0);
    // B never took the slot — no corpse, nothing for the GA-04 grace to hold.
    expect(store.getMobile(pc.room_uuid, phoneB.mobile.id)).toBeNull();
    // A is completely undisturbed.
    expect(sockA.connected).toBe(true);
    expect(store.getMobile(pc.room_uuid, phoneA.mobile.id)).toBe(sockA as unknown as Socket);
  });

  it('stays refused on every retry for as long as A remains live — no silent readmission window', async () => {
    // This is the direct replacement for the old "corpse squats in the GA-04
    // grace" scenario: because B never enters the room, there is no grace
    // window, no `previous !== null` corpse, and therefore no gap in which B
    // could be silently readmitted. Proven here by retrying PAST the old
    // BUSY_SUPPRESS_MS window and asserting the refusal still holds.
    const { pc } = setUpRoom();
    const phoneA = pairPhone(pc.short_code, 'Holder');
    const phoneB = pairPhone(pc.short_code, 'Second');
    store.joinMobile(pc.room_uuid, phoneA.mobile.id, new FakeSocket('sock-a') as unknown as Socket);

    const b1 = wireMobile(new FakeSocket('sock-b-1'));
    const first = await b1.invoke('mobile:reconnect', { token: phoneB.token });
    expect(first).toMatchObject({ error: 'PC_BUSY', retry_after_ms: BUSY_SUPPRESS_MS });

    // Past the window the OLD suppression entry would have lapsed at.
    clock += BUSY_SUPPRESS_MS + 1;
    const b2 = wireMobile(new FakeSocket('sock-b-2'));
    const second = await b2.invoke('mobile:reconnect', { token: phoneB.token });

    // A is STILL live, so `liveContender` finds it again and mints a FRESH
    // window — never a silent `{error: undefined}`.
    expect(second).toMatchObject({ error: 'PC_BUSY', retry_after_ms: BUSY_SUPPRESS_MS });
    expect(store.getMobile(pc.room_uuid, phoneB.mobile.id)).toBeNull();
  });

  it('the SAME rule applies to a fresh mobile:pair, not only mobile:reconnect', async () => {
    const { pc, pcSock } = setUpRoom();
    const phoneA = pairPhone(pc.short_code, 'Holder');
    store.joinMobile(pc.room_uuid, phoneA.mobile.id, new FakeSocket('sock-a') as unknown as Socket);

    const sockB = wireMobile(new FakeSocket('sock-b'));
    const ack = await sockB.invoke('mobile:pair', { short_code: pc.short_code, mobile_name: 'Brand New Phone' });

    // The pairing row IS minted (the token is real and the phone can retry
    // with it — see PairingInfo/PC_BUSY handling on the mobile side) but the
    // ROOM is what refuses it.
    expect(ack).toMatchObject({ error: 'PC_BUSY', retryable: true, retry_after_ms: BUSY_SUPPRESS_MS });
    expect(joinFramesFor(pcSock, String(ack.pairing_id ?? ''))).toHaveLength(0);
  });

  it('once A actually leaves, B is admitted and announced normally on its next attempt', async () => {
    const { pc, pcSock } = setUpRoom();
    const phoneA = pairPhone(pc.short_code, 'Holder');
    const phoneB = pairPhone(pc.short_code, 'Second');
    const sockA = new FakeSocket('sock-a');
    store.joinMobile(pc.room_uuid, phoneA.mobile.id, sockA as unknown as Socket);

    const refused = await wireMobile(new FakeSocket('sock-b-1')).invoke('mobile:reconnect', { token: phoneB.token });
    expect(refused.error).toBe('PC_BUSY');

    // A genuinely disconnects (not evicted — just leaves) and the room slot is
    // vacated the way `disconnect.handler.ts` does it in production.
    sockA.disconnect(true);
    store.leaveMobile(pc.room_uuid, phoneA.mobile.id, sockA.id);

    clock += BUSY_SUPPRESS_MS + 1;
    const admitted = await wireMobile(new FakeSocket('sock-b-2')).invoke('mobile:reconnect', { token: phoneB.token });

    expect(admitted.error).toBeUndefined();
    expect(joinFramesFor(pcSock, phoneB.mobile.id)).toHaveLength(1);
  });

  it('a genuine first arrival (no contender at all) is still announced exactly once', async () => {
    // Guards the fix from the opposite failure: the new gate must not refuse a
    // phone that is not actually contending with anyone.
    const { pc, pcSock } = setUpRoom();
    const phone = pairPhone(pc.short_code, 'Pixel 9');

    const sock = wireMobile(new FakeSocket('sock-only'));
    const ack = await sock.invoke('mobile:reconnect', { token: phone.token });

    expect(ack.error).toBeUndefined();
    expect(joinFramesFor(pcSock, phone.mobile.id)).toHaveLength(1);
  });

  it('a phone reconnecting to its OWN slot is never treated as its own contender', async () => {
    // `liveContender` excludes `thisPairingId` — the same phone's ladder
    // returning on a new socket (A-1's own scenario, pinned end-to-end in
    // presence-liveness.test.ts) must not be refused PC_BUSY against itself.
    const { pc, pcSock } = setUpRoom();
    const phone = pairPhone(pc.short_code, 'Pixel 9');

    const sock1 = wireMobile(new FakeSocket('sock-1'));
    await sock1.invoke('mobile:reconnect', { token: phone.token });

    const sock2 = wireMobile(new FakeSocket('sock-2'));
    const again = await sock2.invoke('mobile:reconnect', { token: phone.token });

    expect(again.error).toBeUndefined();
    expect(store.getMobile(pc.room_uuid, phone.mobile.id)).toBe(sock2 as unknown as Socket);
    // The re-announce mechanism (joinAndNotify's `previous.id !== socket.id`)
    // still fires for the SAME pairing's socket swap.
    expect(joinFramesFor(pcSock, phone.mobile.id)).toHaveLength(2);
  });
});
