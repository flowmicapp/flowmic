// GA-04 (P1) disconnect-recovery minimum closed loop: the audio session belongs to the (room, pairing),
// not to the socket. Asserts the whole grace contract with an INJECTED clock —
// no test ever sleeps 30 real seconds:
//   ① a drop does NOT dispose the session; a rebind inside the window keeps the
//      SAME orchestrator and re-points stt:final at the NEW socket;
//   ② expiry disposes AND only THEN does the PC hear pc:mobile-left;
//   ③ a phone back inside the window → the PC NEVER hears pc:mobile-left;
//   ④ audio:pause stops the engine feed (and mirrors to the PC), resume restores;
//   ⑤ delivery:'none' keeps the PC leg at ZERO frames through the whole
//      drop/rebind dance — GA-02's privacy gate is not allowed to regress.
//
// SPEC-REF: 06 §2 (F-2135 grace / resumeFromGrace), 04 §3.3 (pause/resume),
// AUDIO_DEFAULTS.mobile_drop_grace_ms.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import {
  AudioSessionRegistry, adoptAudioSession, audioSessionKey, isDeliberateLeave, mobileLeftOnGraceExpiry,
} from '../src/engine/audio-registry';
import { makeSttEmitter } from '../src/engine/stt-factory';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const ROOM = 'room-1';
const PAIRING = 'mob-1';
const KEY = audioSessionKey(ROOM, PAIRING);
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string; audioSessions?: unknown } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this {
    this.handlers.set(event, cb);
    return this;
  }
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  fire(event: string, payload?: unknown, ack?: (r: unknown) => void): void {
    this.handlers.get(event)?.(payload, ack);
  }
  received(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

/** Injected scheduler: nothing is real, everything is fired by hand. */
function fakeClock(): {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  pending: () => number;
  lastDelay: () => number | null;
  fireAll: () => void;
} {
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 1;
  let lastMs: number | null = null;
  const setTimeoutFn = ((cb: () => void, ms: number) => {
    lastMs = ms;
    const id = nextId++;
    timers.set(id, { cb, ms });
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((h: unknown) => { timers.delete(h as number); }) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    pending: () => timers.size,
    lastDelay: () => lastMs,
    fireAll: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const t of due) t.cb();
    },
  };
}

/** A fake orchestrator that runs the REAL emitter seam: every pushed chunk
 *  echoes an stt:final, so "which socket got the final" is directly observable. */
interface FakeOrchestrator {
  chunks: number[];
  disposed: number;
  finished: number;
  pushChunk(seq: number, dataB64: string, tsMs: number): void;
  finish(): Promise<void>;
  dispose(): void;
}

function harness(opts: { delivery?: 'inject' | 'none'; pcInRoom?: boolean } = {}): {
  registry: AudioSessionRegistry;
  clock: ReturnType<typeof fakeClock>;
  store: RoomStore<FakeSocket>;
  pc: FakeSocket;
  built: FakeOrchestrator[];
  attach: (socket: FakeSocket) => void;
  newMobile: (id: string) => FakeSocket;
} {
  const clock = fakeClock();
  const registry = new AudioSessionRegistry({ setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  const store = new RoomStore<FakeSocket>();
  const pc = new FakeSocket('pc-sock');
  if (opts.pcInRoom !== false) store.joinPc(ROOM, pc);
  const built: FakeOrchestrator[] = [];

  const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
  const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };

  const sttFactory = (args: SttStartArgs): FakeOrchestrator => {
    // The REAL emitter, fed the REAL resolver the handler produced — this is
    // what proves stt:final follows the session onto the new socket.
    const emitter = makeSttEmitter({
      resolveSocket: args.resolveSocket ?? ((): null => null),
      store: store as unknown as RoomStore<Socket>,
      roomUuid: ROOM,
      delivery: args.delivery,
    });
    const orch: FakeOrchestrator = {
      chunks: [],
      disposed: 0,
      finished: 0,
      pushChunk(seq) {
        orch.chunks.push(seq);
        emitter.emit('stt:final', { text: `#${seq}` });
      },
      async finish() { orch.finished += 1; },
      dispose() { orch.disposed += 1; },
    };
    built.push(orch);
    return orch;
  };

  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: noopGuard,
    usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    sessions: registry,
    sttFactory: sttFactory as unknown as AudioHandlerDeps['sttFactory'],
  };

  function attach(socket: FakeSocket): void {
    registerAudioHandlers(socket as unknown as Socket, deps);
  }
  function newMobile(id: string): FakeSocket {
    const s = new FakeSocket(id);
    s.data = { auth: { kind: 'mobile', userId: 'u1', pairingId: PAIRING }, roomUuid: ROOM };
    store.joinMobile(ROOM, PAIRING, s);
    attach(s);
    return s;
  }
  return { registry, clock, store, pc, built, attach, newMobile };
}

/** Exactly what bootstrap's mobile disconnect branch does. `reason` is socket.io's
 *  own disconnect reason — the default is a BLIP; `client namespace disconnect`
 *  is the phone saying it is leaving (leaveRoom → socket.disconnect()). */
function dropMobile(h: ReturnType<typeof harness>, socket: FakeSocket, reason = 'transport close'): void {
  socket.fire('disconnect', {}); // the audio handler's half (session grace)
  h.registry.beginGrace(
    KEY,
    mobileLeftOnGraceExpiry({
      store: h.store as unknown as RoomStore<Socket>,
      roomUuid: ROOM,
      pairingId: PAIRING,
      socketId: socket.id,
    }),
    socket.id,
  );
  if (isDeliberateLeave(reason)) h.registry.expireGraceNow(KEY);
}

describe('GA-04 audio session survives a mobile socket drop', () => {
  it('arms the protocol grace window (mobile_drop_grace_ms) instead of disposing', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    a.fire('audio:chunk', { seq: 0, data_b64: 'AA==', ts_ms: 1 });
    expect(h.built).toHaveLength(1);

    dropMobile(h, a);
    expect(h.built[0]?.disposed).toBe(0); // NOT torn down on the transport edge
    expect(h.registry.get(KEY)).not.toBeNull();
    expect(h.clock.pending()).toBe(1);
    expect(h.clock.lastDelay()).toBe(AUDIO_DEFAULTS.mobile_drop_grace_ms);
  });

  it('a rebind inside the window resumes the SAME orchestrator and re-points stt:final', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    a.fire('audio:chunk', { seq: 0, data_b64: 'AA==', ts_ms: 1 });
    expect(a.received('stt:final')).toHaveLength(1);
    dropMobile(h, a);

    // The phone is back on a NEW socket: mobile:reconnect re-joins the room and
    // the one-line hook adopts the session.
    const b = h.newMobile('sock-b');
    expect(adoptAudioSession(b as unknown as Socket, ROOM, PAIRING)).toBe(true);
    expect(h.clock.pending()).toBe(0); // grace cancelled

    b.fire('audio:chunk', { seq: 1, data_b64: 'AQ==', ts_ms: 2 });
    expect(h.built).toHaveLength(1);              // no second engine
    expect(h.built[0]?.chunks).toEqual([0, 1]);   // the same session kept counting
    expect(b.received('stt:final')).toHaveLength(1);
    expect(a.received('stt:final')).toHaveLength(1); // the dead socket got nothing more
    expect(h.pc.received('stt:final')).toHaveLength(2);
  });

  it('a resumed stream rebinds even without the explicit hook (belt-and-braces)', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    dropMobile(h, a);
    const b = h.newMobile('sock-b'); // no adoptAudioSession call
    b.fire('audio:chunk', { seq: 7, data_b64: 'AQ==', ts_ms: 9 });
    expect(h.built[0]?.chunks).toEqual([7]);
    expect(b.received('stt:final')).toHaveLength(1);
    expect(h.clock.pending()).toBe(0); // the frame itself cancelled the window
  });

  it('grace expiry disposes the session AND only THEN tells the PC pc:mobile-left', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    dropMobile(h, a);
    expect(h.pc.received('pc:mobile-left')).toHaveLength(0); // not yet — blip debounce

    h.clock.fireAll();
    expect(h.built[0]?.disposed).toBe(1);
    expect(h.registry.get(KEY)).toBeNull();
    expect(h.pc.received('pc:mobile-left')).toEqual([{ mobile_id: PAIRING }]);
    expect(h.store.getMobile(ROOM, PAIRING)).toBeNull();
  });

  it('a phone back inside the window: the PC NEVER hears pc:mobile-left', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    dropMobile(h, a);
    const b = h.newMobile('sock-b');
    adoptAudioSession(b as unknown as Socket, ROOM, PAIRING);

    h.clock.fireAll(); // whatever is left must not announce a departure
    expect(h.pc.received('pc:mobile-left')).toHaveLength(0);
    expect(h.built[0]?.disposed).toBe(0);
    b.fire('audio:stop', {}, () => {});
    expect(h.built[0]?.finished).toBe(1);
  });

  it('an idle drop (no utterance) still delays the departure by the same window', () => {
    const h = harness();
    const a = h.newMobile('sock-a'); // never speaks
    dropMobile(h, a);
    expect(h.pc.received('pc:mobile-left')).toHaveLength(0);
    expect(h.clock.lastDelay()).toBe(AUDIO_DEFAULTS.mobile_drop_grace_ms);
    h.clock.fireAll();
    expect(h.pc.received('pc:mobile-left')).toEqual([{ mobile_id: PAIRING }]);
  });

  it('a DELIBERATE leave skips the window entirely — the PC hears it at once', () => {
    // Blip debounce protects blips, not departures. owner 2026-07-27: the capsule
    // lingered ~30 s after the phone backed out to the connection list.
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    dropMobile(h, a, 'client namespace disconnect');

    expect(h.pc.received('pc:mobile-left')).toEqual([{ mobile_id: PAIRING }]);
    expect(h.built[0]?.disposed).toBe(1);      // teardown ran, in the same order
    expect(h.registry.get(KEY)).toBeNull();
    expect(h.store.getMobile(ROOM, PAIRING)).toBeNull();
    expect(h.clock.pending()).toBe(0);         // nothing left armed
  });

  it('a deliberate leave from a DISPLACED socket still cannot kill the live session', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    const b = h.newMobile('sock-b');
    adoptAudioSession(b as unknown as Socket, ROOM, PAIRING);
    dropMobile(h, a, 'client namespace disconnect'); // A quits AFTER B adopted

    expect(h.pc.received('pc:mobile-left')).toHaveLength(0);
    expect(h.built[0]?.disposed).toBe(0);
    expect(h.registry.get(KEY)).not.toBeNull();
  });

  it('a late disconnect from the DISPLACED socket cannot kill the live session', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    const b = h.newMobile('sock-b');
    adoptAudioSession(b as unknown as Socket, ROOM, PAIRING);
    dropMobile(h, a); // socket A's disconnect arrives AFTER B adopted
    expect(h.clock.pending()).toBe(0);
    b.fire('audio:chunk', { seq: 3, data_b64: 'AQ==', ts_ms: 4 });
    expect(h.built[0]?.chunks).toEqual([3]);
    expect(h.pc.received('pc:mobile-left')).toHaveLength(0);
  });

  it('a new audio:start on the same pairing supersedes a survivor (one engine per pairing)', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    dropMobile(h, a);
    const b = h.newMobile('sock-b');
    b.fire('audio:start', START, () => {}); // a NEW utterance, not a resume
    expect(h.built).toHaveLength(2);
    expect(h.built[0]?.disposed).toBe(1);
    expect(h.clock.pending()).toBe(0);
    h.clock.fireAll();
    expect(h.pc.received('pc:mobile-left')).toHaveLength(0);
  });

  it('stopAll disarms every window and disposes every engine (bootstrap close)', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    dropMobile(h, a);
    h.registry.stopAll();
    expect(h.built[0]?.disposed).toBe(1);
    expect(h.registry.size()).toBe(0);
    h.clock.fireAll();
    expect(h.pc.received('pc:mobile-left')).toHaveLength(0); // no narration on shutdown
  });
});

describe('GA-04 audio:pause / audio:resume (04 §3.3 M→S→PC)', () => {
  it('paused stops the engine feed and mirrors to the PC; resume restores both', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    a.fire('audio:chunk', { seq: 0, data_b64: 'AA==', ts_ms: 1 });

    a.fire('audio:pause', { reason: 'background' });
    expect(h.pc.received('audio:pause')).toEqual([{ reason: 'background' }]);
    a.fire('audio:chunk', { seq: 1, data_b64: 'AQ==', ts_ms: 2 });
    expect(h.built[0]?.chunks).toEqual([0]); // the paused chunk never reached the engine

    a.fire('audio:resume', {});
    expect(h.pc.received('audio:resume')).toHaveLength(1);
    a.fire('audio:chunk', { seq: 2, data_b64: 'Ag==', ts_ms: 3 });
    expect(h.built[0]?.chunks).toEqual([0, 2]);
  });

  it('an invalid audio:pause (no reason) is rejected, never a half-applied pause', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    a.fire('audio:pause', {});
    expect(h.pc.received('audio:pause')).toHaveLength(0);
    a.fire('audio:chunk', { seq: 0, data_b64: 'AA==', ts_ms: 1 });
    expect(h.built[0]?.chunks).toEqual([0]);
  });

  it('the pause state survives a rebind (the utterance is still paused)', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', START, () => {});
    a.fire('audio:pause', { reason: 'background' });
    dropMobile(h, a);
    const b = h.newMobile('sock-b');
    adoptAudioSession(b as unknown as Socket, ROOM, PAIRING);
    b.fire('audio:chunk', { seq: 0, data_b64: 'AA==', ts_ms: 1 });
    expect(h.built[0]?.chunks).toEqual([]);
    b.fire('audio:resume', {});
    b.fire('audio:chunk', { seq: 1, data_b64: 'AQ==', ts_ms: 2 });
    expect(h.built[0]?.chunks).toEqual([1]);
  });
});

describe("GA-02 stays closed: delivery:'none' keeps the PC at zero frames across the grace", () => {
  it('drop → rebind → pause/resume → stop never leaks a single frame to the PC', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    a.fire('audio:chunk', { seq: 0, data_b64: 'AA==', ts_ms: 1 });
    dropMobile(h, a);
    const b = h.newMobile('sock-b');
    adoptAudioSession(b as unknown as Socket, ROOM, PAIRING);
    b.fire('audio:chunk', { seq: 1, data_b64: 'AQ==', ts_ms: 2 });
    b.fire('audio:pause', { reason: 'background' });
    b.fire('audio:resume', {});
    b.fire('audio:stop', {}, () => {});

    expect(h.built[0]?.chunks).toEqual([0, 1]); // the session really ran
    expect(b.received('stt:final')).toHaveLength(1); // and the phone got its truth
    expect(h.pc.emitted).toHaveLength(0); // …while the PC heard NOTHING at all
  });
});

// Card F1 / owner ruling ①: "the PC should treat the phone as 'paused' (still paired, capsule just retracted)".
// The phone backgrounding while IDLE (the common case — the user switched windows
// without saying anything) has NO utterance for the pause to be about, so
// `current()` answers null and the pre-F1 handler dropped the frame right here.
// That drop is invisible from either end: the phone emits, the PC has a handler,
// and nothing ever joins the two. This is the seam that makes both halves real.
describe('card F1 — an IDLE phone going to background reaches the PC as a pause', () => {
  it('mirrors audio:pause / audio:resume with NO utterance in flight', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    // Deliberately NO audio:start.
    a.fire('audio:pause', { reason: 'background' });
    expect(h.pc.received('audio:pause')).toEqual([{ reason: 'background' }]);
    a.fire('audio:resume', {});
    expect(h.pc.received('audio:resume')).toHaveLength(1);
  });

  it('an idle pause is still schema-checked — a reason-less frame reaches no PC', () => {
    const h = harness();
    const a = h.newMobile('sock-a');
    a.fire('audio:pause', {});
    expect(h.pc.emitted).toHaveLength(0);
  });

  it('with no PC in the room the idle pause is simply dropped (no throw)', () => {
    const h = harness({ pcInRoom: false });
    const a = h.newMobile('sock-a');
    a.fire('audio:pause', { reason: 'background' });
    a.fire('audio:resume', {});
    expect(h.pc.emitted).toHaveLength(0);
  });
});
