// NR-38 (second half) — the cold-open cap for an engine whose open() is a MODEL
// LOAD, not a dial.
//
// WHY THIS EXISTS AND WHY IT EXISTS *NOW*. The 5 s `DEFAULT_ENGINE_SPAWN_TIMEOUT_MS`
// could not fire against sherpa-local at all while its native recognizer
// construction blocked the event loop (ledger §25 / G10: the timer never ran, and
// the settled work promise — a microtask — beat it every time). The commit before
// this one freed the loop, which makes that cap LIVE on this path for the first
// time. 5 s is a number chosen for REACHING A SERVER, and the two measurements
// this repo has say a model load is a different question:
//
//   SenseVoice, 229 MB      cold open 1_852 ms         (dev-pc-a, measured 2026-09-13)
//   whisper-turbo, 1.03 GB  frame at 6_019‥7_976 ms    (ledger §25, 8 cold runs)
//
// ⇒ leaving 5 s in place would have made a whisper-turbo cold start that works
// today fail loudly instead. That is not the defect NR-38 reported, and it is not
// a trade this card may make silently.
//
// ⚠️ WHAT THIS SUITE DOES NOT PROVE: that 60 s is the right number. It is the
// ceiling `verify/golden/g10-record-only.mjs` already reasoned its way to for this
// exact path (MOBILE_TOLD_CEILING_MS), for the reason written there — a LIVENESS
// bound, not a performance claim. What is asserted here is only that the value
// production hands the orchestrator is the local one for the local engine, the
// default for everybody else, and that an explicit caller still outranks both.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE_SPAWN_TIMEOUT_MS, LOCAL_MODEL_ENGINE_SPAWN_TIMEOUT_MS, spawnTimeoutForEngine,
} from '../src/stt/orchestrator-types';
import { makeSttOrchestratorFactory } from '../src/stt/engine-factory';
import { AudioSession } from '../src/stt/audio/session';
import type { EngineFactory } from '../src/stt/engine-router';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import type { SttEngineId } from '@flowmic/protocol';

class StubEngine implements SttEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  async open(): Promise<void> {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}
const stubFactory: EngineFactory = (id, cfg) => new StubEngine(id, cfg) as unknown as SttEngine;

function settingsWith(rows: Record<string, unknown>): SettingsRepo {
  return {
    readAll: (): SettingRow[] => [],
    read: (_u, key): SettingRow | null =>
      key in rows ? ({ key, value: rows[key], updated_at: '' } as unknown as SettingRow) : null,
    write: (): SettingRow => { throw new Error('unused'); },
    remove: (): boolean => false,
  };
}

/** The cap the PRODUCTION factory actually handed this session's orchestrator.
 *  Read off the built object rather than re-derived here: a test that recomputes
 *  the value proves the arithmetic and not the wiring, which is the exact shape
 *  this repo keeps catching. */
function capFor(engineId: string, orchestratorOptions?: { engineSpawnTimeoutMs?: number }): number {
  const factory = makeSttOrchestratorFactory({
    settings: settingsWith({ 'stt.routings': [{ language: '*', engine_id: engineId, api_key: 'k' }] }),
    mode: 'standalone',
    engineFactory: stubFactory,
    managedDefault: () => null,
    ...(orchestratorOptions ? { orchestratorOptions } : {}),
  });
  const built = factory(new AudioSession(), 'zh', 'u1', undefined);
  return (built.orchestrator as unknown as { engineSpawnTimeoutMs: number }).engineSpawnTimeoutMs;
}

describe('NR-38 · the local model engine gets a cold-open cap of its own', () => {
  it('names the local engine and nobody else', () => {
    expect(spawnTimeoutForEngine('sherpa-local')).toBe(LOCAL_MODEL_ENGINE_SPAWN_TIMEOUT_MS);
    expect(spawnTimeoutForEngine('deepgram')).toBeUndefined();
    expect(spawnTimeoutForEngine('soniox')).toBeUndefined();
  });

  it('the production factory really hands it to the orchestrator', () => {
    expect(capFor('sherpa-local')).toBe(LOCAL_MODEL_ENGINE_SPAWN_TIMEOUT_MS);
  });

  it('a network engine still gets the default — the change is not global', () => {
    // The negative control. Without it「sherpa-local gets 60 s」would also pass
    // if the cap had simply been raised for everything.
    expect(capFor('deepgram')).toBe(DEFAULT_ENGINE_SPAWN_TIMEOUT_MS);
  });

  it('an explicit caller still outranks the local default', () => {
    // The spread order this depends on is stated at the call site; the reason it
    // is asserted here is that `readOrchestratorTuningFromEnv()` is a real caller
    // (stt-factory.ts), so an operator who pinned the cap must keep it.
    expect(capFor('sherpa-local', { engineSpawnTimeoutMs: 1_234 })).toBe(1_234);
  });
});
