// REGRESSION (owner real-chain UAT 2026-07-26): the terminal stt:final flushed
// by finish() on audio:stop reached NOBODY on a paired session.
//
// GA-04 decoupled the audio session from the socket and made the stt:* emitter
// resolve the mobile leg via a LIVE `sessions.get(key)` lookup. audio:stop then
// `detach`es the entry (deletes the map key) BEFORE calling finish(), which
// flushes the engine's terminal final — so the lookup returned null and the
// final was emitted to nothing. Interims survived (the entry was still mapped
// while audio:chunk ran), which is exactly why every unit test and the golden
// path missed it: only the flush-on-stop leg was broken, and no test fed a fake
// whose finish() actually EMITS.
//
// This test feeds exactly that: a fake orchestrator whose finish() flushes a
// terminal final through the REAL emitter the handler built. It must reach the
// mobile after audio:stop.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry, audioSessionKey } from '../src/engine/audio-registry';
import { makeSttEmitter } from '../src/engine/stt-factory';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const ROOM = 'room-1';
const PAIRING = 'mob-1';
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string; audioSessions?: unknown } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload?: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
  finals(): unknown[] { return this.emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload); }
}

function harness(delivery: 'inject' | 'none' = 'inject') {
  const registry = new AudioSessionRegistry();
  const store = new RoomStore<FakeSocket>();
  const pc = new FakeSocket('pc');
  store.joinPc(ROOM, pc);

  const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
  const usage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };

  const sttFactory = (args: SttStartArgs) => {
    const emitter = makeSttEmitter({
      resolveSocket: args.resolveSocket ?? ((): null => null),
      store: store as unknown as RoomStore<Socket>,
      roomUuid: ROOM,
      delivery: args.delivery,
    });
    return {
      pushChunk(seq: number): void { emitter.emit('stt:interim', { text: `i${seq}`, confidence: 1, language: 'zh', segment_idx: 0 }); },
      // The flush: a REAL engine emits its terminal final here, on stop.
      async finish(): Promise<void> { emitter.emit('stt:final', { text: '终态最终结果', confidence: 1, language: 'zh', segment_idx: 0, is_segment: false, duration_ms: 1200 }); },
      dispose(): void {},
    };
  };

  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker: usage,
    store: store as unknown as RoomStore<Socket>,
    sessions: registry,
    sttFactory: sttFactory as unknown as AudioHandlerDeps['sttFactory'],
  };
  const mob = new FakeSocket('mob-sock');
  mob.data = { auth: { kind: 'mobile', userId: 'u1', pairingId: PAIRING }, roomUuid: ROOM };
  store.joinMobile(ROOM, PAIRING, mob);
  registerAudioHandlers(mob as unknown as Socket, deps);
  return { registry, store, pc, mob };
}

describe('audio:stop flushes the terminal final to the mobile', () => {
  it('the final survives detach — it is NOT emitted into the void', async () => {
    const { mob } = harness('inject');
    mob.fire('audio:start', START, () => {});
    mob.fire('audio:chunk', { seq: 0, data_b64: 'AAAA', ts_ms: 1 });
    expect(mob.emitted.some((e) => e.event === 'stt:interim')).toBe(true);

    // audio:stop detaches then finish() flushes — the bug dropped this final.
    let acked = false;
    mob.fire('audio:stop', {}, () => { acked = true; });
    await new Promise((r) => setImmediate(r)); // let the finish() microtask run

    expect(acked).toBe(true);
    const finals = mob.finals();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ text: '终态最终结果', is_segment: false });
  });

  it('a record-only utterance still delivers its final to the phone (never to the PC)', async () => {
    // delivery:'none' gates the PC fan-out, NOT the phone's own final: the
    // utterance is still shown on the phone, it just never went to the PC.
    const { mob, pc } = harness('none');
    mob.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    mob.fire('audio:chunk', { seq: 0, data_b64: 'AAAA', ts_ms: 1 });
    mob.fire('audio:stop', {}, () => {});
    await new Promise((r) => setImmediate(r));

    expect(mob.finals()).toHaveLength(1);
    expect(pc.emitted.some((e) => e.event === 'stt:final')).toBe(false);
  });
});
