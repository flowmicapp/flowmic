// Codex review item 4 (2026-09-24): a backlog-scaled terminal flush vs the fixed
// `audio:stop` finish watchdog.
//
// SPEC-REF:
//   src/stt/flush-final.ts `networkFlushCapMs` (card RC-2: a network engine that
//     reports a processed position gets `backlog + 3 s`, not the flat cap)
//   src/socket/handlers/audio.handler.ts `audio:stop` (`finish()` raced against
//     the P1-1 fallback watchdog, then `dispose()`)
//   _dispatch/2026-09-24-codex-review-rc1.out.md item 4
//
// The claim: a vendor 30 s behind gets a 33 s flush allowance, but every normal
// `audio:stop` disposes after a fixed 20 s, closing the orchestrator and the
// vendor socket under a healthy flush — the terminal final is lost.
//
// Driven end to end on ONE fake clock: the REAL audio handler, the REAL
// SttSessionBridge and the REAL SttEngineOrchestrator; only the engine is a
// stand-in, because a vendor that is 30 s behind cannot be produced otherwise.
// It reports `ackedAudioMs = 0` (processed nothing yet), so the orchestrator's
// own backlog is everything the leg was fed, and its flush answers 25 s after it
// was asked — inside the 33 s cap the orchestrator itself computes.
//
// SAW RED on the unfixed handler 〔2026-09-24, lane-c, `.local/rc2/codex4-current.log`〕:
// 「nothing disposes the session while its flush is inside its own cap: expected
// true to be false」, with the handler's own 「did not settle within the fallback
// window」 line. REVERSE CONTROL after the fix: `armFinishWatchdog({}, …)` (the
// session's fed audio ignored ⇒ the fixed base) ⇒ both cases red
// (`codex4-red-fed-ignored.log`); restored, same command green.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { SttEngineId } from '@flowmic/protocol';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { networkFlushCapMs } from '../src/stt/flush-final';
import { flushCapGrowthMs } from '../src/socket/handlers/audio-stop-watchdog';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const ROOM = 'room-1';
const PAIRING = 'mob-1';
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
const CHUNK_MS = 200;
const CHUNK_BYTES = 6_400;
const SPOKEN_MS = 30_000;
const VENDOR_ANSWERS_AFTER_MS = 25_000;

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string; audioSessions?: unknown } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload?: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

/** A network leg 30 s behind: it has processed nothing, and its flush answers
 *  VENDOR_ANSWERS_AFTER_MS later with everything it was sent. */
class BehindLeg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'soniox';
  private _state: EngineState = 'closed';
  closedBeforeFinal = false;
  finalEmitted = false;
  get state(): EngineState { return this._state; }
  get ackedAudioMs(): number { return 0; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { /* heard */ }
  flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this._state === 'open') {
          this.finalEmitted = true;
          this.emit('final', { kind: 'final', text: 'the whole thirty seconds', confidence: 0.9, language: 'zh', duration_ms: SPOKEN_MS });
        }
        resolve();
      }, VENDOR_ANSWERS_AFTER_MS);
    });
  }
  async close(): Promise<void> { if (!this.finalEmitted) this.closedBeforeFinal = true; this._state = 'closed'; }
}

function harness(hung = false) {
  const registry = new AudioSessionRegistry();
  const store = new RoomStore<FakeSocket>();
  store.joinPc(ROOM, new FakeSocket('pc'));
  const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
  const usage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
  const legs: BehindLeg[] = [];
  const finals: unknown[] = [];
  let disposed = false;
  const sttFactory = (): unknown => {
    if (hung) return { pushChunk() {}, finish: () => new Promise<void>(() => { /* never settles */ }), dispose() { disposed = true; }, fedAudioMs: SPOKEN_MS };
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(session, () => { const l = new BehindLeg(); legs.push(l); return l; }, {}),
        isByok: false, gated: false,
      }),
      emitter: { emit: (event: string, payload: unknown) => { if (event === 'stt:final') finals.push(payload); } },
      userId: 'u1', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => {},
      levelIntervalMs: 0,
    });
    const dispose = bridge.dispose.bind(bridge);
    bridge.dispose = (): void => { disposed = true; dispose(); };
    return bridge;
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
  store.joinMobile(ROOM, PAIRING, mob as unknown as FakeSocket);
  registerAudioHandlers(mob as unknown as Socket, deps);
  return { mob, legs, finals, isDisposed: (): boolean => disposed };
}

function voicedB64(seq: number): string {
  const b = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i += 2) b.writeInt16LE(i % 64 < 32 ? 8_000 : -8_000, i);
  b.writeUInt16LE(seq, 0);
  return b.toString('base64');
}

describe('audio:stop — a healthy backlog flush is not disposed under it (Codex item 4)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a vendor 30 s behind answers at 25 s ⇒ the terminal final reaches the phone, and dispose waits for it', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.mob.fire('audio:start', START, () => {});
    await vi.advanceTimersByTimeAsync(0);
    for (let seq = 0; seq * CHUNK_MS < SPOKEN_MS; seq++) {
      h.mob.fire('audio:chunk', { seq, data_b64: voicedB64(seq), ts_ms: seq * CHUNK_MS });
      await vi.advanceTimersByTimeAsync(CHUNK_MS);
    }
    expect(h.legs, 'precondition: one leg, open').toHaveLength(1);
    // Precondition: the allowance the orchestrator itself races for this backlog
    // is 33 s — longer than the vendor needs, so the flush is HEALTHY.
    expect(networkFlushCapMs(3_000, SPOKEN_MS)).toBeGreaterThan(VENDOR_ANSWERS_AFTER_MS);

    h.mob.fire('audio:stop', {}, () => {});
    await vi.advanceTimersByTimeAsync(VENDOR_ANSWERS_AFTER_MS - 1);
    expect(h.isDisposed(), 'nothing disposes the session while its flush is inside its own cap').toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.legs[0]!.closedBeforeFinal, 'the vendor socket was not closed under the flush').toBe(false);
    expect(h.finals, 'the terminal final reached the phone').toHaveLength(1);
    expect(h.isDisposed(), 'and the finish chain then disposed it').toBe(true);
  });

  it('a finish() that never settles is still disposed — at the base window plus the flush-cap growth for its audio', async () => {
    // The P1-1 guarantee, kept: the window is longer, not infinite. 20 s is the
    // handler's base (AUDIO_STOP_FINISH_WATCHDOG_MS, pinned at exactly that by
    // test/audio-stop-finish-watchdog.test.ts for a session that reports no audio).
    vi.useFakeTimers();
    const h = harness(true);
    h.mob.fire('audio:start', START, () => {});
    h.mob.fire('audio:stop', {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    const window = 20_000 + flushCapGrowthMs(SPOKEN_MS);
    expect(window, 'precondition: longer than the old fixed window').toBeGreaterThan(20_000 + SPOKEN_MS);
    await vi.advanceTimersByTimeAsync(window - 1);
    expect(h.isDisposed()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.isDisposed(), 'disposed once its derived window ran out').toBe(true);
  });
});
