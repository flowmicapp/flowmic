// 🔴 W8-4 (card fix-020) — `audio:auto-stopped` says WHY the recording ended.
//
// `engine/stt-session.ts` used to emit a constant `reason:'hard_limit'` and throw
// the `limit_origin` away, so the phone said "recording reached the 5-minute cap" in four languages
// regardless of what actually happened. These tests pin the origin → reason table
// and, just as importantly, pin the two things the table must REFUSE to do:
// borrow a sentence for an origin it does not know, and let a prototype key pass
// for an origin at all.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, stated here rather than left to be assumed:
// 「a user records until their quota runs out and reads the right sentence」 is a
// device-line scenario. The phone does not read `reason` yet — `ptt_session.dart`
// exposes `Stream<void>` — so nothing downstream of this emit has been exercised
// by a machine. See the report for the required follow-up.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { safeParseEvent } from '@flowmic/protocol';
import type { SttEngineId } from '@flowmic/protocol';
import type { AudioSession, HardLimitOrigin } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  textOnFlush = '说完了';
  readonly id: SttEngineId = 'custom-openai-compatible';
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {
    this.emit('final', { kind: 'final', text: this.textOnFlush, confidence: 1, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

interface Cap { event: string; payload: unknown }

/**
 * A real bridge over a real orchestrator over a real AudioSession — the same
 * three objects production wires together. `clampMs` is applied inside `build`,
 * which is the one moment the session is still `idle` and the clamp is legal.
 */
function makeBridge(opts: { clampMs?: number } = {}): {
  bridge: SttSessionBridge; emitted: Cap[]; orch: () => SttEngineOrchestrator; eng: FakeEngine;
} {
  const eng = new FakeEngine();
  const emitted: Cap[] = [];
  let orchestrator: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession, _lang: string, _uid: string, _vad?: VadGate) => {
      if (opts.clampMs !== undefined) session.clampHardLimitMs(opts.clampMs);
      orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
      return { orchestrator, isByok: false, gated: false };
    },
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => {},
    levelIntervalMs: 0,
  });
  return { bridge, emitted, orch: () => orchestrator!, eng };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const autoStops = (emitted: Cap[]): { reason: string }[] =>
  emitted.filter((e) => e.event === 'audio:auto-stopped').map((e) => e.payload as { reason: string });

/** Drive the bridge's own subscription with the payload `handleAutoStop`
 *  produces. Used for the origin the END-TO-END path can no longer reach: after
 *  card N1-B4 the `engine_session` ceiling ROLLS OVER instead of stopping
 *  (`stt/audio/session.ts` onHardLimit), so a real session cannot be made to
 *  auto-stop on it. The payload shape is copied from the single producer —
 *  `orchestrator-core.ts` handleAutoStop, `{ reason, limit_origin }`. */
function driveAutoStop(orch: SttEngineOrchestrator, limit_origin: unknown): void {
  orch.emit('auto-stopped', { reason: 'hard_limit', limit_origin });
}

describe('W8-4: audio:auto-stopped carries the real limit origin', () => {
  it('🔴 quota_budget ⇒ reason:quota_exhausted — END TO END through a real session', async () => {
    // The production-reachable origin, and after N1-B4 the ONLY one: a ceiling
    // that came from the user's remaining budget still stops the recording.
    // 60 ms stands in for 「the minutes ran out」 — the branch reads the ORIGIN,
    // never the size of the number.
    const { bridge, emitted, eng } = makeBridge({ clampMs: 60 });
    eng.textOnFlush = '额度用完前的最后一句';
    await sleep(200);

    expect(autoStops(emitted)).toEqual([{ reason: 'quota_exhausted' }]);
    // Ordering is part of the contract, not an accident of this run: the phone's
    // FSM leaves RECORDING on this frame and only then accepts the terminal
    // final behind it (ptt_inbound.dart). Asserted with a positive control —
    // the final really did arrive, so a pass cannot mean 「neither happened」.
    const stopAt = emitted.findIndex((e) => e.event === 'audio:auto-stopped');
    const finalAt = emitted.findIndex((e) => e.event === 'stt:final');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(finalAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(finalAt);
    bridge.dispose();
  });

  it('🔴 engine_session ⇒ reason:hard_limit — the 5-minute sentence survives for it', async () => {
    // Deliberately NOT deleted by this card: a real time ceiling is still a real
    // time ceiling, and `hard_limit` is still its honest answer. Driven at the
    // bridge's subscription rather than end-to-end because N1-B4 made this origin
    // a rollover — see [[driveAutoStop]]. It is still reachable in the field: a
    // relay running a pre-B4 build stamps it.
    const { bridge, emitted, orch } = makeBridge();
    await sleep(20); // let orchestrator.start() finish wiring
    driveAutoStop(orch(), 'engine_session');
    await sleep(20);

    expect(autoStops(emitted)).toEqual([{ reason: 'hard_limit' }]);
    bridge.dispose();
  });

  it('🔴 the two origins do NOT produce the same sentence (the whole point)', async () => {
    // The property the constant violated, stated as a property. A green here is
    // what goes red the moment anyone re-hardcodes the reason — which is exactly
    // the reverse control this card owes.
    const seen: string[] = [];
    for (const origin of ['engine_session', 'quota_budget'] satisfies HardLimitOrigin[]) {
      const { bridge, emitted, orch } = makeBridge();
      await sleep(20);
      driveAutoStop(orch(), origin);
      await sleep(20);
      seen.push(autoStops(emitted)[0]!.reason);
      bridge.dispose();
    }
    expect(seen).toEqual(['hard_limit', 'quota_exhausted']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('🔴 an origin with no honest reason emits NOTHING — it does not borrow one', async () => {
    // The forbidden shape, asserted directly: 「map the unknown onto hard_limit」
    // IS the defect W8-4 names. A future origin must fail to compile against
    // `satisfies Record<HardLimitOrigin, …>`; if one ever reaches here at runtime
    // anyway, this layer refuses to invent a sentence for it.
    for (const bogus of ['device_thermal', '', 'HARD_LIMIT', 42, null, undefined]) {
      const { bridge, emitted, orch } = makeBridge();
      await sleep(20);
      driveAutoStop(orch(), bogus);
      await sleep(20);
      expect(autoStops(emitted)).toEqual([]); // negative...
      bridge.dispose();
    }
    // ...and its positive control, on the SAME harness: a zero above must mean
    // 「the bridge refused」, never 「the probe was blind」.
    const { bridge, emitted, orch } = makeBridge();
    await sleep(20);
    driveAutoStop(orch(), 'quota_budget');
    await sleep(20);
    expect(autoStops(emitted)).toEqual([{ reason: 'quota_exhausted' }]);
    bridge.dispose();
  });

  it('🔴 a prototype key is not an origin (`Object.hasOwn`, not truthiness)', async () => {
    // `table['toString']` on a plain object literal returns a FUNCTION, not
    // undefined. Without the `hasOwn` guard that non-reason reaches the emit and
    // ships `reason: [Function]` on the wire.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const { bridge, emitted, orch } = makeBridge();
      await sleep(20);
      driveAutoStop(orch(), key);
      await sleep(20);
      expect(autoStops(emitted)).toEqual([]);
      bridge.dispose();
    }
  });

  it('every reason this bridge can emit is one the protocol schema accepts', async () => {
    // The table cannot ship a value the wire rejects: the frame is validated by
    // the SCHEMA here, not by a second hand-written list of legal strings.
    for (const origin of ['engine_session', 'quota_budget'] satisfies HardLimitOrigin[]) {
      const { bridge, emitted, orch } = makeBridge();
      await sleep(20);
      driveAutoStop(orch(), origin);
      await sleep(20);
      const parsed = safeParseEvent('audio:auto-stopped', autoStops(emitted)[0]);
      expect(parsed.success).toBe(true);
      bridge.dispose();
    }
  });
});
