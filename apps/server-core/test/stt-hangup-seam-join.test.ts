// card SEAM-1 (NR-244 layer 1) — a silence hang-up seam produces a SEPARATED final.
//
// SPEC-REF:
//   src/stt/leg-seam-join.ts (the rule; measured "Kubernetes.And pointed" through a local relay)
//   src/stt/leg-facts.ts `foldFinal` / `draftJoin` (where the halves meet)
//
// Drives the REAL orchestrator with the real 3 s idle hang-up. The engine is a scripted Soniox-shaped
// fake: finals only at flush, and the text of each leg is fixed — the first leg's flush closes it with
// "." or "—" and the second leg's first token has no leading space, exactly as Soniox does.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
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

/** Soniox-shaped: cumulative interims, the final only at flush. [answersFlush] false = the flush is
 *  never answered, so the terminal text falls back to the accumulators. */
class ScriptedLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  constructor(private readonly finalText: string, private readonly answersFlush = true) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { /* the text is scripted */ }
  async flush(): Promise<void> { if (this.answersFlush) this.emit('final', { kind: 'final', text: this.finalText, confidence: 1, language: 'en', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  say(text: string): void { this.emit('interim', { kind: 'interim', text, confidence: 1, language: 'en' }); }
  drop(): void { this._state = 'failed'; this.emit('error', new SttEngineError('STT_NETWORK_DROP', 'ws closed unexpectedly', true)); }
}

async function rig(legsText: { final: string; answersFlush?: boolean }[]) {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const legs: ScriptedLeg[] = [];
  let voiced = true;
  const orch = new SttEngineOrchestrator(session, () => {
    const s = legsText[Math.min(legs.length, legsText.length - 1)]!;
    const leg = new ScriptedLeg(s.final, s.answersFlush ?? true);
    legs.push(leg);
    return leg;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, engineFlushTimeoutMs: 1_000,
    softSegmentMs: 600_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,
  });
  const terminal: string[] = [];
  const interims: string[] = [];
  orch.on('final', (f: { text: string; is_segment: boolean }) => { if (!f.is_segment) terminal.push(f.text); });
  orch.on('interim', (e: { text: string }) => interims.push(e.text));
  orch.on('error', () => { /* listener mandatory */ });
  orch.on('engine-status', () => { /* not measured here */ });
  await orch.start({ language: 'en', mode: 'realtime' });
  let seq = 0;
  const pump = async (chunks: number): Promise<void> => {
    for (let i = 0; i < chunks; i++) {
      orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(6_400) });
      await clock.advance(200);
    }
  };
  const silenceChunks = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / 200) + 1;
  const speak = async (n: number): Promise<void> => { voiced = true; await pump(n); };
  const pause = async (): Promise<void> => { voiced = false; await pump(silenceChunks); };
  const release = async (): Promise<string> => { const p = orch.stop(); await clock.advance(3_000); await p; return terminal.join(''); };
  return { legs, speak, pause, release, interims };
}

describe('SEAM-1 — a LADDER seam whose merge finds no overlap is a bare join too', () => {
  it('the dead leg banked "Kubernetes." + the new leg says "And point it." => separated', async () => {
    const r = await rig([{ final: 'unused' }, { final: 'And point it at the replica.' }]);
    await r.speak(10);
    r.legs[0]!.say('We should deploy the API to Kubernetes.');
    r.legs[0]!.drop(); // the rung is 1 s out; the new leg re-hears the window (RC-5b: replayedHeard)
    await r.speak(10);
    expect(r.legs).toHaveLength(2); // POSITIVE CONTROL: the ladder seam really exists
    expect(await r.release()).toBe('We should deploy the API to Kubernetes. And point it at the replica.');
  });
});

describe('SEAM-1 — the two halves of a paused utterance reach the PC separated', () => {
  it('"Kubernetes." + "And point it" => one space after the period (the period is kept)', async () => {
    const r = await rig([{ final: 'We should deploy the API to Kubernetes.' }, { final: 'And point it at the replica.' }]);
    await r.speak(10);
    await r.pause();
    await r.speak(10);
    expect(r.legs).toHaveLength(2); // POSITIVE CONTROL: the hang-up seam really exists
    expect(await r.release()).toBe('We should deploy the API to Kubernetes. And point it at the replica.');
  });

  it('the forced finalize\'s "—" is replaced by a space when the phrase goes on', async () => {
    const r = await rig([{ final: 'Tell Priya that the—' }, { final: 'Anthropic invoice came in.' }]);
    await r.speak(10);
    await r.pause();
    await r.speak(10);
    expect(r.legs).toHaveLength(2);
    expect(await r.release()).toBe('Tell Priya that the Anthropic invoice came in.');
  });

  it('a CJK seam stays without a space', async () => {
    const r = await rig([{ final: '今天没有投票。' }, { final: '投票会在周五' }]);
    await r.speak(10);
    await r.pause();
    await r.speak(10);
    expect(r.legs).toHaveLength(2);
    expect(await r.release()).toBe('今天没有投票。投票会在周五');
  });

  it('the live preview of the new leg is separated too', async () => {
    const r = await rig([{ final: 'We grew from 3,400 users.' }, { final: 'To 12,000 users.' }]);
    await r.speak(10);
    await r.pause();
    await r.speak(5);
    r.legs[1]!.say('To 12,000');
    expect(r.interims[r.interims.length - 1]).toBe('We grew from 3,400 users. To 12,000');
    await r.speak(5);
    expect(await r.release()).toBe('We grew from 3,400 users. To 12,000 users.');
  });

  it('a new leg whose flush never answers falls back to the accumulators — separated', async () => {
    const r = await rig([{ final: 'We grew from 3,400 users.' }, { final: 'unused', answersFlush: false }]);
    await r.speak(10);
    await r.pause();
    await r.speak(5);
    r.legs[1]!.say('To 12,000 users');
    await r.speak(5);
    expect(await r.release()).toBe('We grew from 3,400 users. To 12,000 users');
  });
});
