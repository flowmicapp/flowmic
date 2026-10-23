// Card IDLE-1 — the RT-2 hang-up counts SILENCE IN THE RECEIVED AUDIO, not
// wall-clock time without audio; and a held press waits 10 s, not 3 s.
//
// SPEC-REF:
//   docs/decisions/2026-10-14-owner-long-recording-unpolished-no-mark.md
//     (appendix 「句中空闲挂断」: 9 of 11 natural mid-press hang-ups were uplink
//     stalls — the gap was longer than the gate-closed audio)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 IDLE-1 bullet
//
// Same seam as `stt-idle-hangup.test.ts`: real AudioSession + orchestrator +
// ladder on the RT-3 harness, a perfect stand-in engine, and the VAD gate as a
// boolean the test drives. What is new here is a third kind of time:
//   speak(n) — n chunks the gate ACCEPTS
//   quiet(n) — n chunks the gate REFUSES (the phone streams silence too)
//   stall(ms) — the clock moves and NO chunk arrives (the uplink is stuck)
// The old wall-clock countdown could not tell `quiet` from `stall`; that is the
// defect.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { makeSttOrchestratorFactory } from '../src/stt/engine-factory';
import { managedDefaultRouting } from '../src/stt/managed-default';
import { VadGate } from '../src/stt/vad-gate';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import type { EngineFactory } from '../src/stt/engine-router';
import type { SttEngineId } from '@flowmic/protocol';
import { CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, frame, mergedFinalText, type WireFrame } from './fixtures/stt-outage-harness';

/** The production numbers, written as literals ON PURPOSE: importing them would
 *  make the wiring test below agree with whatever the constants say. */
const PRESS_MS = 10_000;
const CONTINUOUS_MS = 3_000;
const BACKSTOP_MS = 15_000;

async function makeRig(idleHangupMs: number, idleWallBackstopMs?: number) {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const engines: TranscribingEngine[] = [];
  let voiced = true;
  const orch = new SttEngineOrchestrator(session, () => {
    const e = new TranscribingEngine(ZH, clock, { open: 'ok', finalEveryN: 0 });
    engines.push(e);
    return e;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 600_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs,
    ...(idleWallBackstopMs !== undefined ? { idleWallBackstopMs } : {}),
  } as ConstructorParameters<typeof SttEngineOrchestrator>[2]);
  const wire: WireFrame[] = [];
  const errors: unknown[] = [];
  const statuses: string[] = [];
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: { segment_idx: number; text: string }) => wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text }));
  orch.on('error', (e: unknown) => errors.push(e));
  orch.on('engine-status', (s: { status: string }) => statuses.push(s.status));
  await orch.start({ language: ZH.lang, mode: 'realtime' });
  let seq = 0;
  const pump = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
      seq += 1;
      await clock.advance(CHUNK_MS);
    }
  };
  return {
    clock, engines, orch, errors, statuses,
    speak: async (n: number) => { voiced = true; await pump(n); },
    quiet: async (n: number) => { voiced = false; await pump(n); },
    stall: async (ms: number) => { await clock.advance(ms); },
    merged: () => mergedFinalText(wire),
  };
}

const chunksFor = (ms: number): number => Math.round(ms / CHUNK_MS);

describe('IDLE-1 (1) — an uplink stall is not silence', () => {
  it('🔴 a 6 s stall mid-utterance, then more speech: no hang-up, one leg, every word', async () => {
    // The strictest threshold (3 s, long recording): under the old wall-clock
    // countdown this stall alone hung the leg up and the next word redialled.
    const rig = await makeRig(CONTINUOUS_MS);
    await rig.speak(10);
    await rig.stall(6_000);
    await rig.speak(10);
    expect(rig.engines.length).toBe(1);
    expect(rig.engines[0]!.state).toBe('open');
    await rig.orch.stop();
    expect(rig.merged()).toBe(ZH.slice(0, 20));
    expect(rig.errors).toEqual([]);
    expect(rig.statuses).toEqual(['ready']);
  });

  it('a stall does not reset the silence either: 2 s quiet + 2 s stall + 1.2 s quiet ⇒ hang-up', async () => {
    const rig = await makeRig(CONTINUOUS_MS);
    await rig.speak(10);
    await rig.quiet(10);
    await rig.stall(2_000);
    expect(rig.engines[0]!.state).toBe('open'); // positive control: 2 s of silence counted so far
    await rig.quiet(6);
    expect(rig.engines[0]!.state).toBe('closed');
    expect(rig.engines.length).toBe(1);
  });
});

describe('IDLE-1 (2) — a held press waits 10 s of silence', () => {
  it('5 s of real silence during a press: the leg stays up', async () => {
    const rig = await makeRig(PRESS_MS);
    await rig.speak(10);
    await rig.quiet(chunksFor(5_000));
    expect(rig.engines[0]!.state).toBe('open');
    await rig.speak(5);
    expect(rig.engines.length).toBe(1);
  });

  it('11 s of real silence during a press: hung up (silently, flushed first)', async () => {
    const rig = await makeRig(PRESS_MS);
    await rig.speak(10);
    // The count runs from the START of the last voiced chunk (engine-idle-hangup.ts
    // `noteChunk`): 200 ms + 9.6 s = 9.8 s, just under.
    await rig.quiet(chunksFor(9_600));
    expect(rig.engines[0]!.state).toBe('open'); // positive control: just under the threshold
    await rig.quiet(chunksFor(1_200));
    expect(rig.engines[0]!.state).toBe('closed');
    expect(rig.engines[0]!.finalsEmitted.join('')).toBe(ZH.slice(0, 10));
    expect(rig.statuses).toEqual(['ready']);
    expect(rig.errors).toEqual([]);
  });

  it('🔴 wiring: the production factory gives a press 10 s and a long recording 3 s', () => {
    expect(builtIdleMs(false)).toBe(PRESS_MS);
    expect(builtIdleMs(true)).toBe(CONTINUOUS_MS);
  });
});

describe('IDLE-1 — the wall-clock backstop (the vendor closes a socket that hears nothing)', () => {
  it('🔴 a 14 s stall during a press does not hang up', async () => {
    const rig = await makeRig(PRESS_MS);
    await rig.speak(10);
    await rig.stall(14_000);
    expect(rig.engines[0]!.state).toBe('open');
  });

  it('a 16 s stall hangs up through the same silent path — no reconnecting, no error — and voice redials', async () => {
    const rig = await makeRig(PRESS_MS);
    await rig.speak(10);
    await rig.stall(BACKSTOP_MS + 1_000);
    expect(rig.engines[0]!.state).toBe('closed');
    expect(rig.engines[0]!.finalsEmitted.join('')).toBe(ZH.slice(0, 10));
    expect(rig.statuses).toEqual(['ready']);
    expect(rig.errors).toEqual([]);
    await rig.speak(5);
    expect(rig.engines.length).toBe(2);
  });
});

describe('IDLE-1 (3) — the long-recording value is unchanged (pin)', () => {
  it('3 s of audio since the last voiced chunk began still hangs up a long recording', async () => {
    const rig = await makeRig(CONTINUOUS_MS);
    await rig.speak(10);
    await rig.quiet(13);
    expect(rig.engines[0]!.state).toBe('open'); // 200 ms voiced chunk + 2.6 s = 2.8 s
    await rig.quiet(2);
    expect(rig.engines[0]!.state).toBe('closed');
  });
});

// ── production wiring: build through `makeSttOrchestratorFactory` and read the
// threshold the orchestrator was actually TOLD (`engine-factory.ts`, the one writer).
function settingsWith(): SettingsRepo {
  return {
    readAll: (): SettingRow[] => [], read: (): SettingRow | null => null,
    write: (): SettingRow => { throw new Error('unused'); }, remove: (): boolean => false,
  };
}
class StubEngine implements SttEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}
function builtIdleMs(continuous: boolean): number {
  const factory = makeSttOrchestratorFactory({
    settings: settingsWith(), mode: 'saas',
    engineFactory: ((id, cfg) => new StubEngine(id, cfg) as unknown as SttEngine) as EngineFactory,
    managedDefault: () => managedDefaultRouting({
      FLOWMIC_MANAGED_STT_ENABLED: '1', FLOWMIC_MANAGED_STT_ENGINE: 'soniox', FLOWMIC_MANAGED_STT_API_KEY: 'platform-key',
    } as unknown as NodeJS.ProcessEnv),
  });
  const built = factory(new AudioSession(), 'zh', 'u1', new VadGate(), { continuous });
  expect(built.gated).toBe(true); // precondition: only a gated leg is hung up at all
  return (built.orchestrator as unknown as { idle: { idleMs: number } }).idle.idleMs;
}
