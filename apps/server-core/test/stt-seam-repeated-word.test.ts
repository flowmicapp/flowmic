// card RC-5b — a word the speaker said twice across a leg seam stays twice;
// audio a reconnect re-feeds is still de-duplicated.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (RC-5b block)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §3.2 (「没有投票。投票会在」
//     came out with one 「投票」)
//
// Drives the REAL orchestrator. The engine is a scripted fake: its final on a
// flush is fixed per leg, so the seam's two sides are exactly the CR-12-E ones.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { SttEngineError, type SttEngine, type EngineState } from '../src/stt/engines/base';

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id; };
  clearTimeout = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await drain();
    }
    this.now = target;
    await drain();
  }
}
const drain = async (): Promise<void> => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

class ScriptedLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  heardBytes = 0;
  constructor(private readonly finalText: string) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer): void { this.heardBytes += chunk.length; }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: this.finalText, confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  say(text: string): void { this.emit('interim', { kind: 'interim', text, confidence: 1, language: 'zh' }); }
  drop(): void { this._state = 'failed'; this.emit('error', new SttEngineError('STT_NETWORK_DROP', 'ws closed unexpectedly', true)); }
}

async function rig(finals: string[], opts: { softSegmentMs: number; softSegmentGraceMs: number }) {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const legs: ScriptedLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => {
    const leg = new ScriptedLeg(finals[Math.min(legs.length, finals.length - 1)]!);
    legs.push(leg);
    return leg;
  }, { now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, engineFlushTimeoutMs: 1_000, ...opts });
  const terminal: string[] = [];
  orch.on('final', (f: { text: string; is_segment: boolean }) => { if (!f.is_segment) terminal.push(f.text); });
  orch.on('error', () => { /* listener mandatory */ });
  orch.on('engine-status', () => { /* ladder frames; not what this file measures */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  let seq = 0;
  const pump = async (chunks: number): Promise<void> => {
    for (let i = 0; i < chunks; i++) {
      orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(6_400) });
      await clock.advance(200);
    }
  };
  const release = async (): Promise<string> => { const p = orch.stop(); await clock.advance(3_000); await p; return terminal.join(''); };
  return { clock, legs, pump, release };
}

describe('RC-5b — the seam merge runs only when the new leg re-heard audio', () => {
  it('🔴 a leg ROTATION replays nothing already heard: 「没有投票」 + 「投票会在周五」 keeps both 「投票」', async () => {
    // The flush answers at once, so no chunk lands in the round trip and the new
    // leg's replay overlap is 0 — the case root-cause §3.2 describes.
    const r = await rig(['今天没有投票', '投票会在周五'], { softSegmentMs: 2_000, softSegmentGraceMs: 1_000 });
    await r.pump(20); // 4 s: the leg span (2 s + 1 s) expires once, nothing ends the row
    expect(r.legs).toHaveLength(2); // POSITIVE CONTROL: the seam really exists
    expect(await r.release()).toBe('今天没有投票投票会在周五');
  });

  it('a LADDER reconnect re-feeds heard audio: the restated words are still merged once', async () => {
    const r = await rig(['今天没有投票', '没有投票会在周五'], { softSegmentMs: 600_000, softSegmentGraceMs: 15_000 });
    await r.pump(10);
    r.legs[0]!.say('今天没有投票');
    r.legs[0]!.drop();          // the rung is 1 s out
    await r.pump(10);
    expect(r.legs).toHaveLength(2);
    expect(r.legs[1]!.heardBytes).toBeGreaterThan(0); // POSITIVE CONTROL: the window WAS re-fed
    expect(await r.release()).toBe('今天没有投票会在周五');
  });
});
