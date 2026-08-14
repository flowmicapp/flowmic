// 2026-07-29 (owner: "after connecting to the PC over LAN, the PC capsule can show the focus window and title,
// but the top of the phone transcription UI does not; leave and reconnect and it shows again").
//
// `focus:state` is a CHANGE-only mirror (§3.5, ≥500 ms throttle): the desktop
// emits it when the foreground CHANGES, never on a schedule. A phone that joins
// between two window switches therefore learns nothing — the header stays blank
// until the user happens to alt-tab, and "leave and reconnect" appears to fix it only
// because the reconnect races a fresh change. Identical shape to the 0.2.5
// connection rows (0.2.x wrap-up §4-A): a push-only state is permanent blindness
// for every late listener, and that blindness looks exactly like 「no data」.
//
// The fix is the discipline from §8-2 — a pushed state must also be pullable — applied on the
// server: the room already sees every focus:state, so it keeps the last one and
// replays it to an arriving mobile ON THE SAME EVENT. No protocol change, no PC
// change, no phone change.
//
// What is pinned: the replay happens, it carries the REAL last payload, it goes
// only to the arriving socket, and it is never a stale ghost (a PC that left, or
// a room that never saw a focus, replays nothing).

import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown): void { this.handlers.get(event)?.(payload); }
  received(event: string): unknown[] { return this.emitted.filter((e) => e.event === event).map((e) => e.payload); }
}

const ROOM = 'room-1';
const FOCUS = { window_title: 'flowmic-app - Cursor [管理员]', process_name: 'Cursor' };

function relayFrom(pc: FakeSocket, store: RoomStore<Socket>): void {
  pc.data = { auth: { userId: 'u1', kind: 'pc' }, roomUuid: ROOM };
  registerRelayHandlers(pc as unknown as Socket, { store });
}

describe('a mobile that joins mid-session is SEEDED with the focus already true', () => {
  it('the store keeps the whole last focus payload, and the relay fills it', () => {
    const store = new RoomStore<Socket>();
    const pc = new FakeSocket('pc');
    store.joinPc(ROOM, pc as unknown as Socket);
    relayFrom(pc, store);

    expect(store.getLastFocus(ROOM), 'nothing seen yet ⇒ nothing to replay').toBeUndefined();
    pc.fire('focus:state', FOCUS);
    expect(store.getLastFocus(ROOM)).toEqual(FOCUS);

    // The window TITLE is the half the phone header shows — process_name alone
    // (what the scenario feed already kept) could never have filled it.
    pc.fire('focus:state', { window_title: 'Untitled - Notepad', process_name: 'notepad' });
    expect(store.getLastFocus(ROOM)?.window_title).toBe('Untitled - Notepad');
  });

  it('a PC that leaves or is replaced takes its focus with it — no stale ghost', () => {
    const store = new RoomStore<Socket>();
    const pc = new FakeSocket('pc');
    store.joinPc(ROOM, pc as unknown as Socket);
    relayFrom(pc, store);
    pc.fire('focus:state', FOCUS);

    store.leavePc(ROOM, 'pc');
    expect(store.getLastFocus(ROOM)).toBeUndefined();

    // …and a replacement PC does not inherit the previous one's focus.
    const pc2 = new FakeSocket('pc2');
    store.joinPc(ROOM, pc2 as unknown as Socket);
    relayFrom(pc2, store);
    pc2.fire('focus:state', FOCUS);
    expect(store.getLastFocus(ROOM)).toEqual(FOCUS);
    store.joinPc(ROOM, new FakeSocket('pc3') as unknown as Socket);
    expect(store.getLastFocus(ROOM), 'a fresh PC session starts blind').toBeUndefined();
  });

  it('the seed reaches ONLY the arriving mobile, and every later change still fans out', () => {
    const store = new RoomStore<Socket>();
    const pc = new FakeSocket('pc');
    store.joinPc(ROOM, pc as unknown as Socket);
    relayFrom(pc, store);
    pc.fire('focus:state', FOCUS);

    // The join seam mobile.handler uses (joinMobile + replay of getLastFocus).
    const early = new FakeSocket('m-early');
    store.joinMobile(ROOM, 'm-early', early as unknown as Socket);
    const late = new FakeSocket('m-late');
    store.joinMobile(ROOM, 'm-late', late as unknown as Socket);
    const seed = store.getLastFocus(ROOM);
    if (seed) late.emit('focus:state', seed);

    expect(late.received('focus:state')).toEqual([FOCUS]);
    expect(early.received('focus:state'), 'a seed is not a broadcast').toEqual([]);

    // A real change afterwards still reaches BOTH through the normal mirror —
    // the seed must not replace the live path, only precede it.
    pc.fire('focus:state', { window_title: 'Untitled - Notepad', process_name: 'notepad' });
    expect(early.received('focus:state')).toHaveLength(1);
    expect(late.received('focus:state')).toHaveLength(2);
  });
});
