// Card POL-3 — the shared harness of the pol3-*.test.ts files: the REAL bridge and
// orchestrator, with only the speech engine and the LLM streamer doubled (same
// shape as pol1-polish-stage.test.ts / inc1c-polish-timing.test.ts). Not a test file
// (vitest includes `test/**/*.test.ts` only).
//
// A press is driven the way production drives it: soft-segment finals are emitted
// on the orchestrator's 'final' event (what `runRollover` does), interims on its
// 'interim' event, and the terminal final comes from the engine's flush on
// `finish()`.

import { EventEmitter } from 'node:events';
import { SttSessionBridge, type SttSessionDeps } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer, LlmStreamOpts } from '../src/compose/llm';

export class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  pushes = 0;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null && this.pushes > 0) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'en', duration_ms: 1000 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

export const CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' };

export const pcm = (ms: number): string => {
  const n = (16_000 * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  return b.toString('base64');
};
export const sleep = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The unit text a request polishes: the user message without its context block. */
export function unitOf(user: string): string {
  const close = user.indexOf('<<<END EARLIER SPEECH>>>\n');
  return close === -1 ? user : user.slice(close + '<<<END EARLIER SPEECH>>>\n'.length);
}
/** The context block of a request ('' when none). */
export function contextOf(user: string): string {
  const open = '<<<EARLIER SPEECH — reference only, do not output>>>\n';
  if (!user.startsWith(open)) return '';
  return user.slice(open.length, user.indexOf('\n<<<END EARLIER SPEECH>>>'));
}

/** How the scripted model answers one request. */
export interface Reply {
  full: string;
  /** Reported usage; absent ⇒ the provider said nothing (no metering). */
  usage?: { tokens_in: number; tokens_out: number };
  /** Answer after this many ms (default 10). */
  delayMs?: number;
  /** true ⇒ keep going after the caller aborted (a provider that already answered). */
  ignoreAbort?: boolean;
  /** Answer with this error code instead (e.g. LLM_TIMEOUT from the provider's side). */
  error?: string;
}

export interface Call { system: string; user: string; at: number; aborted: () => boolean; answeredAt?: number }

/** A streamer that records every request and answers per `reply`. An abort before
 *  the answer yields `LLM_TIMEOUT` with no usage, as the real transports do. */
export function scriptedLlm(reply: (unit: string, n: number) => Reply): { calls: Call[]; streamerFor: (p: LlmProtocol) => LlmStreamer } {
  const calls: Call[] = [];
  const streamerFor = (): LlmStreamer => async function* (opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
    const r = reply(unitOf(opts.user), calls.length);
    const call: Call = { system: opts.system, user: opts.user, at: Date.now(), aborted: () => opts.signal?.aborted === true };
    calls.push(call);
    await new Promise<void>((res) => {
      const t = setTimeout(res, r.delayMs ?? 10);
      if (r.ignoreAbort !== true) opts.signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
    if (r.ignoreAbort !== true && opts.signal?.aborted === true) {
      yield { kind: 'error', code: 'LLM_TIMEOUT', message: 'aborted' };
      return;
    }
    call.answeredAt = Date.now();
    if (r.error !== undefined) { yield { kind: 'error', code: r.error, message: 'scripted' }; return; }
    yield { kind: 'done', full: r.full, ...(r.usage ? { usage: r.usage } : {}) };
  };
  return { calls, streamerFor };
}

export interface Frame { ev: string; payload: Record<string, unknown>; at: number }

export interface Rig {
  bridge: SttSessionBridge;
  eng: FakeEngine;
  frames: Frame[];
  usage: { tokensIn: number; tokensOut: number }[];
  /** Emit a soft-segment final the way the orchestrator's rollover does. */
  segment(idx: number, text: string): void;
  /** A soft-segment final with extra orchestrator fields (SEAM-2 `seam_open` / `seam_from`). */
  segmentWith(frame: { text: string; segment_idx: number; seam_open?: true; seam_from?: number }): void;
  interim(idx: number, text: string): void;
  /** Release with `tail` as the terminal final; resolves when `finish()` does. */
  release(tail: string): Promise<void>;
  finals(): Record<string, unknown>[];
}

/** One press on a real bridge. `extra` overrides session deps (polishStages,
 *  continuous, recoveryLeg, …); `polishDeps` is merged into the polish deps
 *  (strength, …). */
export async function press(streamerFor: (p: LlmProtocol) => LlmStreamer, extra: Partial<SttSessionDeps> = {}, polishDeps: Record<string, unknown> = {}): Promise<Rig> {
  const eng = new FakeEngine();
  const frames: Frame[] = [];
  const usage: { tokensIn: number; tokensOut: number }[] = [];
  let orchestrator: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => { orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }); return { orchestrator, isByok: false, gated: false }; },
    emitter: { emit: (ev: string, payload: Record<string, unknown>) => { frames.push({ ev, payload, at: Date.now() }); } },
    userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
    onPolishUsage: (tokensIn: number, tokensOut: number) => { usage.push({ tokensIn, tokensOut }); },
    polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor, ...polishDeps } },
    levelIntervalMs: 0,
    ...extra,
  } as SttSessionDeps);
  await sleep();
  bridge.pushChunk(0, pcm(300), 0);
  const orch = (): SttEngineOrchestrator => orchestrator!;
  return {
    bridge, eng, frames, usage,
    segment: (idx, text) => { orch().emit('final', { text, confidence: 1, language: 'en', segment_idx: idx, is_segment: true, duration_ms: 1000 }); },
    segmentWith: (frame) => { orch().emit('final', { confidence: 1, language: 'en', is_segment: true, duration_ms: 1000, ...frame }); },
    interim: (idx, text) => { orch().emit('interim', { text, confidence: 1, language: 'en', segment_idx: idx }); },
    release: async (tail) => { eng.finalOnFlush = tail; await bridge.finish(); bridge.dispose(); },
    finals: () => frames.filter((f) => f.ev === 'stt:final').map((f) => f.payload),
  };
}
