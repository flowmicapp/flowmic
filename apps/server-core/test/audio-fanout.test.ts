// WP-R2-1b (F-2375): the S→PC audio fan-out. audio:start/stop are additively
// re-emitted to the paired PC once the session is accepted (quota gate passed),
// so the desktop can drive its SPEAKING lock. No new event name, no schema
// change — this asserts the ROUTING: PC receives it, the mobile does not get it
// echoed back, record-only (delivery:'none') is never mirrored, and an empty
// room (no PC) does not throw. Mirrors relay.handler's inject:request forward.

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { makeSttEmitter } from '../src/engine/stt-factory';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import { log } from '../src/log';

/** A minimal socket double: captures .on handlers + .emit calls, fireable. */
class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
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
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void {
    this.handlers.get(event)?.(payload, ack);
  }
  received(event: string): Array<unknown> {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
// A trivial STT orchestrator so audio:start acks ok:true (the fan-out itself is
// independent of this — it fires BEFORE the sttFactory, after the quota gate).
const stubOrchestrator = { pushChunk() {}, finish: async () => {}, dispose() {} };

function wire(pcInRoom: boolean): { mobile: FakeSocket; pc: FakeSocket; store: RoomStore<FakeSocket> } {
  const store = new RoomStore<FakeSocket>();
  const pc = new FakeSocket('pc-sock');
  if (pcInRoom) store.joinPc('room-1', pc);
  const mobile = new FakeSocket('mobile-sock');
  mobile.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: noopGuard,
    usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    sttFactory: () => stubOrchestrator as never,
  };
  registerAudioHandlers(mobile as unknown as Socket, deps);
  return { mobile, pc, store };
}

const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

describe('WP-R2-1b audio:start/stop S→PC fan-out (F-2375)', () => {
  it('re-emits a validated audio:start (and audio:stop) to the paired PC', () => {
    const { mobile, pc } = wire(true);
    let ackOk = false;
    mobile.fire('audio:start', START, (r) => { ackOk = (r as { ok?: boolean }).ok === true; });
    expect(ackOk).toBe(true);
    const fanned = pc.received('audio:start');
    expect(fanned).toHaveLength(1);
    // The PC gets the VALIDATED payload (delivery defaulted in by the schema).
    expect(fanned[0]).toMatchObject({ sample_rate: 16000, mode: 'realtime', source_lang: 'zh' });

    mobile.fire('audio:stop', {}, () => {});
    expect(pc.received('audio:stop')).toHaveLength(1);
  });

  it('never fans out a record-only (delivery:none) utterance — stay-on-phone red line', () => {
    const { mobile, pc } = wire(true);
    mobile.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    expect(pc.received('audio:start')).toHaveLength(0);
    // And the matching audio:stop is not mirrored either (no edge the PC saw begin).
    mobile.fire('audio:stop', {}, () => {});
    expect(pc.received('audio:stop')).toHaveLength(0);
  });

  it('does not echo audio:start back to the mobile itself', () => {
    const { mobile } = wire(true);
    mobile.fire('audio:start', START, () => {});
    expect(mobile.received('audio:start')).toHaveLength(0);
  });

  it('does not throw when the room has no PC (empty-room fan-out is a no-op)', () => {
    const { mobile, pc } = wire(false);
    let ackOk = false;
    expect(() => mobile.fire('audio:start', START, (r) => { ackOk = (r as { ok?: boolean }).ok === true; })).not.toThrow();
    expect(ackOk).toBe(true); // session still accepted
    expect(pc.received('audio:start')).toHaveLength(0);
    expect(() => mobile.fire('audio:stop', {}, () => {})).not.toThrow();
  });

  it('rejects a non-mobile / unauthed audio:start before any fan-out', () => {
    const { mobile, pc } = wire(true);
    mobile.data = { auth: { kind: 'pc', userId: 'u1' }, roomUuid: 'room-1' };
    let ack: unknown;
    mobile.fire('audio:start', START, (r) => { ack = r; });
    expect((ack as { error?: string }).error).toBe('AUTH_TOKEN_INVALID');
    expect(pc.received('audio:start')).toHaveLength(0);
  });
});

// GA-02 (P0, privacy red line): the CONTENT leg. audio:start was already withheld from
// the PC for a record-only utterance (above), but every stt:* frame still went
// out — with a persistent capsule up the PC really rendered noted text. The
// emitter is the one seam every stt:* / audio:auto-stopped frame passes through,
// so the gate lives there and is asserted here directly.
describe('GA-02 stt:* fan-out gate (delivery:none content does not go to the PC)', () => {
  function emitterFor(delivery: 'inject' | 'none', roomUuid: string | null = 'room-1'): {
    mobile: FakeSocket;
    pc: FakeSocket;
    emit: (event: string, payload: unknown) => void;
  } {
    const store = new RoomStore<FakeSocket>();
    const pc = new FakeSocket('pc-sock');
    if (roomUuid) store.joinPc(roomUuid, pc);
    const mobile = new FakeSocket('mobile-sock');
    const emitter = makeSttEmitter({
      // GA-04: the mobile leg is a resolver now (it must follow the session
      // across a reconnect); the delivery gate below is unchanged.
      resolveSocket: () => mobile as unknown as Socket,
      store: store as unknown as RoomStore<Socket>,
      roomUuid,
      delivery,
    });
    return { mobile, pc, emit: (e, p) => emitter.emit(e as never, p as never) };
  }

  // Everything the SttSessionBridge can put through this emitter (stt-session.ts).
  const FRAMES: Array<[string, unknown]> = [
    ['stt:interim', { text: '偷偷说的话', segment_idx: 0 }],
    ['stt:final', { text: '偷偷说的话', segment_idx: 0, is_segment: false }],
    ['stt:level', { amplitude_db: -21.5 }],
    ['stt:error', { code: 'STT_ENGINE_FAILED', message: 'x', retryable: false }],
    ['stt:engine-status', { state: 'reconnecting' }],
    ['audio:auto-stopped', { reason: 'hard_limit' }],
  ];

  it("delivery:'none' → the PC receives NOTHING, the mobile still receives everything", () => {
    const { mobile, pc, emit } = emitterFor('none');
    for (const [event, payload] of FRAMES) emit(event, payload);
    expect(pc.emitted).toHaveLength(0);
    // Withholding is not silent failure: the speaking device gets the full truth,
    // errors included.
    expect(mobile.emitted.map((e) => e.event)).toEqual(FRAMES.map(([e]) => e));
  });

  it("delivery:'inject' still fans every frame out to the paired PC", () => {
    const { mobile, pc, emit } = emitterFor('inject');
    for (const [event, payload] of FRAMES) emit(event, payload);
    expect(pc.emitted.map((e) => e.event)).toEqual(FRAMES.map(([e]) => e));
    expect(mobile.emitted).toHaveLength(FRAMES.length);
    // Same payload crosses both legs (no divergent shaping).
    expect(pc.received('stt:final')[0]).toMatchObject({ text: '偷偷说的话' });
  });

  it('an unroomed socket never reaches for a PC (empty-room no-op, no throw)', () => {
    const { mobile, pc, emit } = emitterFor('inject', null);
    expect(() => emit('stt:interim', { text: 'x' })).not.toThrow();
    expect(pc.emitted).toHaveLength(0);
    expect(mobile.emitted).toHaveLength(1);
  });

  // Device-line forensic (2026-08-12): Soniox refusals ride message as
  // `[error_type] …` but used to leave server.log with only `stt.pool selected`.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stt:error is WARN-logged at the fan-out seam with wire code+message', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { mobile, emit } = emitterFor('inject');
    emit('stt:error', {
      code: 'STT_CONFIG_MISSING',
      message: '[invalid_request] bad audio format',
      retryable: false,
    });
    expect(warn).toHaveBeenCalledWith(
      'stt.error emitted',
      expect.objectContaining({
        code: 'STT_CONFIG_MISSING',
        message: '[invalid_request] bad audio format',
        retryable: false,
        room: 'room-1',
      }),
    );
    // Logging must not swallow delivery.
    expect(mobile.received('stt:error')).toHaveLength(1);
  });
});
