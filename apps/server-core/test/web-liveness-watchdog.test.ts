// NR-69 (owner 2026-09-17) — the 7-second web liveness watch.
//
// What is pinned here, and why each one is worth a case:
//   ① a WEB end that keeps answering is never dropped, across many budgets —
//      the false-positive direction, which would be a product that hangs up on
//      people who are talking;
//   ② a WEB end that has PROVEN it can answer and then goes silent is dropped
//      once past 7 s, and the PC hears `pc:mobile-left` on that same tick rather
//      than 30 s later at the end of the audio grace;
//   ③ NEGATIVE CONTROL — a Dart handset ('app', and the NULL that reads as
//      'app') is never pinged and never dropped. The engine's 20 s pingTimeout
//      is global and was relaxed for exactly that client (lesson N5); if this
//      case ever goes green for the wrong reason the whole scoping argument in
//      web-liveness-watchdog.ts is void;
//   ④ PROBATION — a web client that has NEVER ponged is stood down instead of
//      dropped, so shipping this relay cannot hang up on every cached tab that
//      predates the answering half;
//   ⑤ a pong echoing a nonce this watch never sent is not evidence about now;
//   ⑥ the watch disarms itself on disconnect — no timer, no listener left.
//
// Everything runs on an injected clock and injected timers. Nothing sleeps.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import { makeDisconnectHandler } from '../src/socket/handlers/disconnect.handler';
import { joinAndNotify } from '../src/socket/handlers/mobile-room-admission';
import type { PcRepo } from '../src/db/repos/pc.repo';
import {
  WEB_LIVENESS_PING_MS,
  WEB_LIVENESS_SILENCE_MS,
  armWebLivenessWatchdog,
  wasWebLivenessDrop,
  type WatchedSocket,
} from '../src/socket/web-liveness-watchdog';

const ROOM = 'room-nr69';
const PAIRING = 'mob-nr69';

/** A socket.io-shaped fake: it fires its own `disconnect` listeners when the
 *  server closes it, which is what socket.io does and what this card's whole
 *  presence story depends on. */
class FakeSocket implements WatchedSocket {
  data: Record<string, unknown> = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  connected = true;
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
  constructor(readonly id: string) {}
  on(event: string, listener: (payload: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  off(event: string, listener: (payload: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
    return this;
  }
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  disconnect(_close?: boolean): this {
    if (!this.connected) return this;
    this.connected = false;
    // socket.io's own verdict for a server-side close. `isDeliberateLeave` does
    // NOT accept it — which is the whole reason the watch marks the socket.
    for (const fn of [...(this.listeners.get('disconnect') ?? [])]) fn('server namespace disconnect');
    return this;
  }
  fire(event: string, payload?: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
  }
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
  received(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

/** One clock for both the timers and `now`, so "time passed" means one thing.
 *  The bug this shape prevents: a test that advances timers but not the clock
 *  measures tick COUNT, and the watch deliberately measures elapsed TIME. */
function fakeClock(): {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let t = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    advance: (ms) => {
      const target = t + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const due = timers.get(dueId);
        timers.delete(dueId);
        t = dueAt;
        due?.fn();
      }
      t = target;
    },
    pending: () => timers.size,
  };
}

/** Answer every ping this socket has been sent since the last call. */
function pongEverything(socket: FakeSocket): void {
  for (const payload of socket.received('sys:ping')) {
    socket.fire('sys:pong', { nonce: (payload as { nonce: string }).nonce, ok: true });
  }
}

describe('NR-69 web liveness watchdog', () => {
  it('① never drops a web end that keeps answering', () => {
    const clock = fakeClock();
    const socket = new FakeSocket('s-alive');
    armWebLivenessWatchdog(socket, 'web', {
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });

    // Five budgets' worth of conversation, answering after every ping.
    for (let i = 0; i < 5 * Math.ceil(WEB_LIVENESS_SILENCE_MS / WEB_LIVENESS_PING_MS); i += 1) {
      clock.advance(WEB_LIVENESS_PING_MS);
      pongEverything(socket);
    }

    expect(socket.connected).toBe(true);
    expect(wasWebLivenessDrop(socket)).toBe(false);
    expect(socket.received('sys:ping').length).toBeGreaterThan(5);
  });

  it('② drops a web end that has answered once and then goes silent, just past the budget', () => {
    const clock = fakeClock();
    const socket = new FakeSocket('s-silent');
    armWebLivenessWatchdog(socket, 'web', {
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });

    // One round-trip: the watch is now allowed to enforce.
    clock.advance(WEB_LIVENESS_PING_MS);
    pongEverything(socket);
    const heardAt = clock.now();

    // Silence, but still inside the budget.
    clock.advance(WEB_LIVENESS_SILENCE_MS);
    expect(clock.now() - heardAt).toBe(WEB_LIVENESS_SILENCE_MS);
    expect(socket.connected).toBe(true);

    // One more tick carries it past 7 s.
    clock.advance(WEB_LIVENESS_PING_MS);
    expect(socket.connected).toBe(false);
    expect(wasWebLivenessDrop(socket)).toBe(true);
  });

  it('③ negative control: an app handset — and a pairing row that says nothing — is never watched', () => {
    for (const client of ['app', null, undefined] as const) {
      const clock = fakeClock();
      const socket = new FakeSocket(`s-app-${String(client)}`);
      armWebLivenessWatchdog(socket, client, {
        setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
      });
      clock.advance(WEB_LIVENESS_SILENCE_MS * 10);
      expect(socket.received('sys:ping')).toEqual([]);
      expect(socket.connected).toBe(true);
      expect(clock.pending()).toBe(0);
      expect(socket.listenerCount('sys:pong')).toBe(0);
    }
  });

  it('④ probation: a web client that has never ponged is stood down, not dropped', () => {
    const clock = fakeClock();
    const socket = new FakeSocket('s-old-build');
    armWebLivenessWatchdog(socket, 'web', {
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });

    clock.advance(WEB_LIVENESS_SILENCE_MS * 10);

    expect(socket.connected).toBe(true);
    expect(wasWebLivenessDrop(socket)).toBe(false);
    // Stood down rather than left spinning: nothing is still armed.
    expect(clock.pending()).toBe(0);
    expect(socket.listenerCount('sys:pong')).toBe(0);
  });

  it('⑤ a pong echoing a nonce this watch never sent is not evidence', () => {
    const clock = fakeClock();
    const socket = new FakeSocket('s-wrong-nonce');
    armWebLivenessWatchdog(socket, 'web', {
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });

    // Answer everything, but with somebody else's nonce (room/liveness.ts runs
    // its own probe on these same sockets).
    for (let i = 0; i < 6; i += 1) {
      clock.advance(WEB_LIVENESS_PING_MS);
      socket.fire('sys:pong', { nonce: 'not-ours', ok: true });
    }

    // Never proven alive ⇒ probation stands it down. What must NOT have happened
    // is the watch treating a stranger's nonce as proof and running for ever.
    expect(wasWebLivenessDrop(socket)).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it('⑥ disarms itself when the socket goes away for some other reason', () => {
    const clock = fakeClock();
    const socket = new FakeSocket('s-gone');
    armWebLivenessWatchdog(socket, 'web', {
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });
    expect(clock.pending()).toBe(1);

    socket.disconnect(true);

    expect(clock.pending()).toBe(0);
    expect(socket.listenerCount('sys:pong')).toBe(0);
    expect(socket.listenerCount('disconnect')).toBe(0);
  });
});

describe('NR-69 a watchdog drop reaches the PC immediately', () => {
  function room(): {
    clock: ReturnType<typeof fakeClock>;
    store: RoomStore<Socket>;
    pc: FakeSocket;
    mobile: FakeSocket;
    audio: AudioSessionRegistry;
  } {
    const clock = fakeClock();
    const store = new RoomStore<Socket>();
    const pc = new FakeSocket('pc-1');
    const mobile = new FakeSocket('mob-1');
    const audio = new AudioSessionRegistry({
      setTimeoutFn: clock.setTimer as unknown as typeof setTimeout,
      clearTimeoutFn: clock.clearTimer as unknown as typeof clearTimeout,
    });
    store.joinPc(ROOM, pc.asSocket());
    mobile.data = { roomUuid: ROOM, auth: { kind: 'mobile', pairingId: PAIRING } };
    // Production order: the disconnect listener is bound at connection time,
    // the watch is armed later when the phone takes the room slot.
    mobile.on('disconnect', makeDisconnectHandler(mobile.asSocket(), {
      store, pcs: {} as unknown as PcRepo, audioRegistry: audio,
    }) as (payload: unknown) => void);
    return { clock, store, pc, mobile, audio };
  }

  it('the PC hears pc:mobile-left on the drop, not 30 s later', () => {
    const { clock, store, pc, mobile } = room();
    // The real arming site, with the pairing row's own `client` value.
    joinAndNotify(
      store,
      ROOM,
      { id: PAIRING, mobile_name: 'Browser', client: 'web' },
      mobile.asSocket(),
      (s, c) => armWebLivenessWatchdog(s, c, {
        setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
      }),
    );
    pc.emitted.length = 0;

    clock.advance(WEB_LIVENESS_PING_MS);
    pongEverything(mobile);
    clock.advance(WEB_LIVENESS_SILENCE_MS + WEB_LIVENESS_PING_MS);

    expect(mobile.connected).toBe(false);
    // Same tick — no grace window was waited out.
    expect(pc.received('pc:mobile-left')).toEqual([{ mobile_id: PAIRING }]);
    expect(store.getMobile(ROOM, PAIRING)).toBeNull();
  });

  it('a plain transport drop still gets its grace window (the behaviour NOT being changed)', () => {
    const { clock, store, pc, mobile } = room();
    joinAndNotify(store, ROOM, { id: PAIRING, mobile_name: 'Browser', client: 'web' }, mobile.asSocket(),
      () => { /* no watch in this case: the point is the ordinary drop path */ });
    pc.emitted.length = 0;

    mobile.fire('disconnect', 'transport close');

    expect(pc.received('pc:mobile-left')).toEqual([]);
    clock.advance(60_000);
    expect(pc.received('pc:mobile-left')).toEqual([{ mobile_id: PAIRING }]);
  });

  it('joinAndNotify hands the pairing row\'s client through — app rows are not watched', () => {
    const { store, mobile } = room();
    const seen: Array<string | null | undefined> = [];
    joinAndNotify(store, ROOM, { id: PAIRING, mobile_name: 'Handset', client: null }, mobile.asSocket(),
      (_s, c) => { seen.push(c); });
    expect(seen).toEqual([null]);
  });
});
