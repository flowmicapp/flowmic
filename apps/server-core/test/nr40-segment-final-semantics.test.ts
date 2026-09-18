// Card NR-40 step 1 — MEASURE, do not read: are the relay's soft-segment finals
// INCREMENTAL (only what is new since the previous segment) or CUMULATIVE
// (everything since the press started)?
//
// Why this file exists at all: NR-40's registration entry
// (docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §27)
// marks this fact 【转述】 — nobody had run it. The web client's joining
// strategy and NR-21's phone-side reading both depend on the answer, and the two
// semantics need OPPOSITE joins (append vs. last-wins), so a wrong guess either
// still drops the head or duplicates every word.
//
// WHAT IS REAL HERE AND WHAT IS SCRIPTED: the orchestrator
// (src/stt/orchestrator-core.ts + orchestrator-rollover.ts) and the bridge
// (src/engine/stt-session.ts) are the SHIPPED code. Only the vendor engine and
// the clock are fakes, because a vendor adapter is the one thing a unit test
// cannot hold. The scripted engine reports each leg's text the way a vendor
// adapter does — per leg, never a running total — so if the text leaving the
// relay were accumulated, only the orchestrator could have accumulated it, and
// this test would see it. (It does not: orchestrator-rollover.ts:240-241 clears
// both accumulators at every delivering boundary.)
//
// The assertions below are on the payloads the bridge EMITS (`stt:final`), i.e.
// on what actually reaches a phone / the PC / the web client, never on an
// internal field.
//
// Set NR40_FIXTURE_OUT=<path> to also dump the emitted frames as JSON; that dump
// is the fixture the web repo replays (flowmic-web
// packages/core/src/socket/__fixtures__/nr40-relay-segment-finals.json).

import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

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

/** Batch-style engine id on purpose — a streaming id carries a 5 s flush floor
 *  that would move the clock this test steers. */
class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { /* the byte path is not what this test measures */ }
  async flush(): Promise<void> { if (this.textOnFlush !== null) this.emitFinal(this.textOnFlush); }
  async close(): Promise<void> { this._state = 'closed'; }
  textOnFlush: string | null = null;
  emitFinal(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
}

interface Cap { event: string; payload: Record<string, unknown> }

function harness(engines: FakeEngine[]): { bridge: SttSessionBridge; clock: FakeClock; emitted: Cap[] } {
  const clock = new FakeClock();
  const emitted: Cap[] = [];
  let i = 0;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => ({
      orchestrator: new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 30_000, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: 1_000,
      }),
      isByok: false, gated: false,
    }),
    emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => { /* billing is not what this test measures */ },
    now: clock.nowFn,
    levelIntervalMs: 0,
  });
  return { bridge, clock, emitted };
}

/** card SEG-4: a row is ended on the CHUNK path, so a boundary needs a chunk
 *  after the cadence deadline has passed with a confirmed sentence in hand. */
const chunk = (bridge: SttSessionBridge, clock: FakeClock, seq: number): void =>
  bridge.pushChunk(seq, Buffer.alloc(6_400).toString('base64'), clock.now);

interface FinalCap { text: string; is_segment: boolean; segment_idx: number }
const finals = (emitted: Cap[]): FinalCap[] =>
  emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload as unknown as FinalCap);

describe('NR-40 §1 — what a soft-segment final carries', () => {
  it('🔴 MEASUREMENT: each stt:final carries ONLY ITS OWN SEGMENT (incremental), and the terminal final repeats nothing', async () => {
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const { bridge, clock, emitted } = harness(engines);
    await drain();

    // Segment 0 — the HEAD of the utterance, the part the owner reported missing.
    engines[0]!.textOnFlush = '第一段开头。';
    engines[0]!.emitFinal('第一段开头。');
    await clock.advance(30_000);
    chunk(bridge, clock, 0);
    await drain();

    // Segment 1
    engines[1]!.textOnFlush = '第二段中间。';
    engines[1]!.emitFinal('第二段中间。');
    await clock.advance(30_000);
    chunk(bridge, clock, 1);
    await drain();

    // Segment 2
    engines[2]!.textOnFlush = '第三段后面。';
    engines[2]!.emitFinal('第三段后面。');
    await clock.advance(30_000);
    chunk(bridge, clock, 2);
    await drain();

    // Terminal — the button is released.
    engines[3]!.textOnFlush = '第四段结尾。';
    await bridge.finish();
    await drain();

    const f = finals(emitted);
    expect(f).toHaveLength(4);
    expect(f.map((x) => x.is_segment)).toEqual([true, true, true, false]);
    expect(f.map((x) => x.segment_idx)).toEqual([0, 1, 2, 3]);

    // ── THE MEASUREMENT ────────────────────────────────────────────────────
    // INCREMENTAL: each final is exactly its own span. Under CUMULATIVE
    // semantics frame 1 would read '第一段开头。第二段中间。' and the terminal
    // frame would read the whole utterance.
    expect(f.map((x) => x.text)).toEqual([
      '第一段开头。', '第二段中间。', '第三段后面。', '第四段结尾。',
    ]);
    // Stated as the property, not only as four strings: no frame contains any
    // earlier frame's text, so nothing on the wire is a running total.
    for (let i = 1; i < f.length; i++) {
      for (let j = 0; j < i; j++) expect(f[i]!.text.includes(f[j]!.text)).toBe(false);
    }
    // And the terminal final in particular does NOT repeat the segments — the
    // half of the question NR-21 also needs answered.
    expect(f[3]!.text).toBe('第四段结尾。');
    // ⇒ the whole utterance exists NOWHERE on the wire. It is the CONCATENATION
    //   of the four frames, and only an assembling client can have it.
    expect(f.map((x) => x.text).join('')).toBe('第一段开头。第二段中间。第三段后面。第四段结尾。');

    // The fixture the web repo replays. It carries its own provenance because a
    // JSON file cannot carry a comment, and a recorded fixture whose origin is
    // written down somewhere else is a fixture nobody can re-derive.
    const out = process.env['NR40_FIXTURE_OUT'];
    if (out) {
      const fixture = {
        produced_by: {
          repo: '<private-dev-repo> (the MAIN monorepo)',
          branch: 'lane/nr40-server-segment-semantics',
          test_file: 'apps/server-core/test/nr40-segment-final-semantics.test.ts',
          command: 'NR40_FIXTURE_OUT=<path> npx vitest run test/nr40-segment-final-semantics.test.ts (cwd apps/server-core)',
          what_is_real: 'the shipped SttEngineOrchestrator + SttSessionBridge; only the vendor engine and the clock are scripted',
          measured_semantics: 'INCREMENTAL - every stt:final carries only its own span, and the terminal final repeats no earlier segment',
        },
        frames: emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload),
      };
      writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    }
  });
});
