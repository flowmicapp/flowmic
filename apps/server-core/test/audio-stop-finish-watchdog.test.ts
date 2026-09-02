// Card P0-1 (fallback half) — `audio:stop`'s happy path is
// `finish().finally(() => dispose())`. If `finish()` never settles (a leaked
// vendor promise — e.g. an `engine.close()` that never resolves, which the
// spawn-side raceSpawnTimeout fix in orchestrator-core.ts does not cover),
// `.finally(dispose)` never runs EITHER: the registry slot stays detached
// forever, the ring's retention pin stays pinned, nothing bills, and the
// socket leaks.
//
// This drives the REAL `audio.handler.ts` with a fake orchestrator whose
// `finish()` never resolves, and asserts `dispose()` still runs — because the
// watchdog added alongside AUDIO_STOP_FINISH_WATCHDOG_MS fires it.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Reverting the watchdog (back to the bare
// `s.finish().catch(...).finally(() => s.dispose())` with no race) turns this
// RED: `dispose()` is never called, however far the clock is advanced. Seen
// red locally against the pre-fix source, then the fix was restored — see the
// WP-1 report for this run.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
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
}

interface HangingOrchestrator {
  pushChunk(seq: number, dataB64: string, tsMs: number): void;
  finish(): Promise<void>;
  dispose(): void;
}

/** A fake orchestrator whose `finish()` never settles — the exact leaked-promise
 *  shape a hung `engine.close()`/`engine.open()` produces. `dispose` records
 *  whether (and when) the watchdog actually reached for it. */
function makeHangingOrchestrator(disposedFlag: { called: boolean }): HangingOrchestrator {
  return {
    pushChunk(): void { /* not exercised by this test */ },
    finish(): Promise<void> { return new Promise<void>(() => { /* never settles */ }); },
    dispose(): void { disposedFlag.called = true; },
  };
}

function harness(disposedFlag: { called: boolean }) {
  const registry = new AudioSessionRegistry();
  const store = new RoomStore<FakeSocket>();
  const pc = new FakeSocket('pc');
  store.joinPc(ROOM, pc);

  const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
  const usage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };

  const sttFactory = () => makeHangingOrchestrator(disposedFlag);

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
  return { mob };
}

describe('audio:stop — a finish() that never settles still gets disposed (fallback watchdog)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('dispose() fires once the fallback window elapses, even though finish() is still pending', async () => {
    vi.useFakeTimers();
    const disposedFlag = { called: false };
    const { mob } = harness(disposedFlag);

    mob.fire('audio:start', START, () => {});
    let acked = false;
    mob.fire('audio:stop', {}, () => { acked = true; });
    await Promise.resolve(); // let the synchronous part of the handler run

    // The ack is not gated on finish() settling — it never was.
    expect(acked).toBe(true);
    // Positive control: right after audio:stop, before the watchdog fires,
    // dispose() must NOT already have run — otherwise "dispose() ran" would be
    // vacuous (it could be running unconditionally, immediately, for any reason).
    expect(disposedFlag.called).toBe(false);

    // Advance just short of the fallback window: still nothing.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(disposedFlag.called).toBe(false);

    // Cross the fallback window: the watchdog must have reached for dispose().
    await vi.advanceTimersByTimeAsync(2);
    expect(disposedFlag.called).toBe(true);
  });
});
