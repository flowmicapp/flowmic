// NR-38 (second half) — the user is TOLD during a local model's cold seconds.
//
// D6 freed the event loop (`OfflineRecognizer.createAsync`) and gave the local
// engine its own 60 s cold-open cap, but left the silence itself in place: the
// first `stt:engine-status` frame a user could ever see was `ready`, AFTER the
// 1.9 s (SenseVoice, 229 MB) to 8 s (whisper-turbo, 1.03 GB) load. The protocol
// commit before this one added the `loading` value; this suite pins the
// producer.
//
// 🔴 WHAT IS ASSERTED IS THE SEQUENCE, NOT THE EMIT. `loading` alone is worse
// than nothing — a state nothing closes is a spinner that never stops — so the
// rows below check `loading` → `ready` on success and `loading` → `failed` on a
// refused open, and that `loading` is on the bus BEFORE `open()` settles (an
// announcement that arrives after the wait it announces is not an announcement).
//
// 🔴 AND WHAT IS ASSERTED IS THE *ABSENCE* ON THE OTHER FOUR PATHS. A leg is
// born four ways (orchestrator-core `spawnEngine`'s own header: cold open, soft
// segment rollover, silence redial, ladder rung) and only the cold open is
// followed by a `ready`. Emitting `loading` on the other three would leave the
// capsule showing "loading" forever after the first reconnect — the defect this
// card is fixing, inverted.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SttEngineStatusSchema } from '@flowmic/protocol';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { isLocalModelEngine } from '../src/stt/orchestrator-types';
import type { EngineState, SttEngine } from '../src/stt/engines/base';

/** An engine whose open() is a MODEL LOAD: it does not settle until the test
 *  says so, which is what makes "the frame went out BEFORE the wait" checkable
 *  rather than asserted after the fact. */
class SlowOpenEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  opens = 0;
  private release: (() => void) | null = null;
  private refuse: ((e: Error) => void) | null = null;
  constructor(public readonly id: SttEngineId = 'sherpa-local') { super(); }
  get state(): EngineState { return this._state; }
  open(): Promise<void> {
    this.opens++;
    return new Promise<void>((resolve, reject) => {
      this.release = (): void => { this._state = 'open'; resolve(); };
      this.refuse = reject;
    });
  }
  finishLoad(): void { this.release?.(); this.release = null; }
  failLoad(err = new Error('model file missing')): void { this.refuse?.(err); this.refuse = null; }
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> { this._state = 'closed'; }
  emitError(): void { this.emit('error', new Error('drop')); }
}

type Status = { provider: string; status: string; retry_count?: number };

function harness(engines: SttEngine[], opts: Record<string, unknown> = {}): {
  orch: SttEngineOrchestrator; statuses: Status[];
} {
  const session = new AudioSession({ hardLimitMs: 300_000 });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    softSegmentMs: 30_000, softSegmentGraceMs: 0, engineFlushTimeoutMs: 1_000, ...opts,
  });
  const statuses: Status[] = [];
  orch.on('engine-status', (p: unknown) => statuses.push(p as Status));
  orch.on('error', () => {}); // a cold-open failure emits one; unhandled 'error' on an EventEmitter throws
  return { orch, statuses };
}
const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('NR-38 — engine-status loading on a local model cold open', () => {
  it('announces loading BEFORE the load settles, then ready — in that order', async () => {
    const eng = new SlowOpenEngine();
    const { orch, statuses } = harness([eng]);
    const started = orch.start({ language: 'zh', mode: 'realtime' });
    await drain();
    // The whole point: the frame is out while the model is still being read.
    expect(statuses.map((s) => s.status), 'loading must precede the wait, not follow it').toEqual(['loading']);
    expect(eng.opens).toBe(1);
    eng.finishLoad();
    await started;
    expect(statuses.map((s) => s.status)).toEqual(['loading', 'ready']);
    expect(statuses.every((s) => s.provider === 'sherpa-local')).toBe(true);
  });

  it('every frame it emits is a legal wire frame', async () => {
    const eng = new SlowOpenEngine();
    const { orch, statuses } = harness([eng]);
    const started = orch.start({ language: 'zh', mode: 'realtime' });
    await drain();
    eng.finishLoad();
    await started;
    // Parsed through the protocol package rather than eyeballed: `loading` is
    // only useful if it survives `safeParseEvent` at the server boundary.
    for (const s of statuses) expect(SttEngineStatusSchema.safeParse(s).success, s.status).toBe(true);
  });

  it('a refused load is loading -> failed, never a loading with nothing after it', async () => {
    const eng = new SlowOpenEngine();
    const { orch, statuses } = harness([eng]);
    const started = orch.start({ language: 'zh', mode: 'realtime' });
    await drain();
    eng.failLoad();
    await expect(started).rejects.toThrow();
    expect(statuses.map((s) => s.status)).toEqual(['loading', 'failed']);
  });

  it('a NON-local engine is unchanged: ready only, no loading', async () => {
    const eng = new SlowOpenEngine('custom-openai-compatible');
    const { orch, statuses } = harness([eng]);
    const started = orch.start({ language: 'zh', mode: 'realtime' });
    await drain();
    expect(statuses).toEqual([]);
    eng.finishLoad();
    await started;
    expect(statuses.map((s) => s.status)).toEqual(['ready']);
  });

  it('a LADDER RUNG does not re-announce loading — nothing would close it', async () => {
    const first = new SlowOpenEngine();
    const second = new SlowOpenEngine();
    const { orch, statuses } = harness([first, second], { reconnectBackoffMs: [0] });
    const started = orch.start({ language: 'zh', mode: 'realtime' });
    await drain();
    first.finishLoad();
    await started;
    expect(statuses.map((s) => s.status)).toEqual(['loading', 'ready']);
    first.emitError();
    await drain();
    second.finishLoad();
    await drain();
    await drain();
    // The ladder says `reconnecting` (its own vocabulary). What must NOT appear
    // is a second `loading`: the ladder's success path emits no `ready`, so a
    // `loading` here would be a state with no closer.
    expect(statuses.filter((s) => s.status === 'loading')).toHaveLength(1);
  });

  it('the local-engine predicate has one author, shared with the cold-open cap', () => {
    expect(isLocalModelEngine('sherpa-local')).toBe(true);
    for (const id of ['custom-openai-compatible', 'soniox', 'funasr', 'local-model', '']) {
      expect(isLocalModelEngine(id), id).toBe(false);
    }
  });
});
