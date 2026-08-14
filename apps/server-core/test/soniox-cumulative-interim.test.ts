// REQ-14-01 — 「while holding to speak the live transcript duplicates; after release it does not」, the mechanism, pinned.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (interim = offlineAccum + onlineDraft)
//   packages/stt-cloud/src/engines/soniox.ts (SonioxEngine.interimShape — the
//     declaration this file exercises through a same-shaped stand-in)
//   apps/server-core/src/stt/text-merge.ts (foldInterim: declared 'cumulative'
//     → mergeCumulativeDraft; undeclared → mergeOnlineDraft)
//
// ── THE ASYMMETRY THIS FILE ENCODES ─────────────────────────────────────────
// The owner's report (2026-08-14) named both halves: duplicates WHILE HOLDING,
// clean AFTER RELEASE. That is not two bugs — it is one seam with two exits:
//
//   · hold:    every interim is folded into `onlineDraft` and emitted as
//              `offlineAccum + onlineDraft`. Undeclared, the fold is
//              `mergeOnlineDraft` — a string-relationship guesser whose LAST
//              branch is APPEND — and a cumulative engine's mid-string revision
//              (「。」→「，」 when more speech follows) fails every branch on a
//              short CJK clause (shared prefix 6 < REVISION_MIN_PREFIX 8), so
//              the whole hypothesis is appended to itself, frame after frame.
//   · release: the terminal transcript is `acc.finalText` via flush — the
//              vendor's own finalised text — and the final handler discards the
//              polluted draft (`onlineDraft = ''`). Clean, every time.
//
// So the duplicate lived ONLY in the preview, which is exactly why no terminal
// assertion anywhere could see it (the L9 comment in text-merge.ts said this in
// as many words in 2026-08-02, about this very engine).
//
// The interim frames below are the INT-2 real-device pair (run C,
// scratch/r7-req1205-round2-2026-08-12.md §2-2) — measured shapes, not invented
// ones. INT-2 fixed them for sherpa-local by declaration and left Soniox
// undeclared; REQ-14-01 is that declaration, and this file is its orchestrator-
// level pin, engine faked because the real SonioxEngine needs a websocket
// (its own declaration is pinned in packages/stt-cloud/test/soniox.test.ts).

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { EngineState, InterimShape, SttEngine } from '../src/stt/engines/base';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';

/** A stand-in whose interim/final frames are SCRIPTED BY THE TEST, so the exact
 *  strings measured on the real service can be driven through the real
 *  orchestrator fold. `flush()` emits the vendor's finalised text — the Soniox
 *  contract (final only at end-of-stream, `acc.finalText`). */
class ScriptedEngine extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  readonly interimShape: InterimShape | undefined;
  private _state: EngineState = 'closed';
  /** What the vendor would finalise for the whole stream — set by the test. */
  finalText = '';
  constructor(shape: InterimShape | undefined) { super(); this.interimShape = shape; }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(_chunk: Buffer, _ts_ms: number): void { /* frames are scripted, not derived */ }
  async flush(): Promise<void> {
    this.emit('final', { kind: 'final', text: this.finalText, confidence: 1, language: 'zh', duration_ms: 1_000 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
  frame(text: string): void {
    this.emit('interim', { kind: 'interim', text, confidence: 1, language: 'zh' });
  }
}

interface Rig {
  eng: ScriptedEngine;
  interims: string[];
  finals: string[];
  stop(): Promise<void>;
}

async function rig(shape: InterimShape | undefined): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: 300_000,
  });
  session.start();
  const eng = new ScriptedEngine(shape);
  const orch = new SttEngineOrchestrator(session, () => eng, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 600_000,
  });
  const interims: string[] = [];
  const finals: string[] = [];
  orch.on('interim', (e: { text: string }) => interims.push(e.text));
  orch.on('final', (f: { text: string; is_segment: boolean }) => { if (!f.is_segment) finals.push(f.text); });
  orch.on('error', () => { /* asserted through the finals, not needed here */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  return { eng, interims, finals, stop: () => orch.stop() };
}

/** The INT-2 real-device pair: one sentence, revised mid-string as it grows —
 *  the 「。」 stops ending the sentence the moment more speech follows it. */
const FRAME_1 = '跟你说个事啊。';
const FRAME_2 = '跟你说个事啊，明天下午。';

describe('REQ-14-01 — a declared-cumulative engine never shows the hold-time duplicate', () => {
  it('a mid-string revision REPLACES the draft: the opening reaches the wire once per frame', async () => {
    const r = await rig('cumulative');
    r.eng.frame(FRAME_1);
    r.eng.frame(FRAME_2);

    // Frame for frame, the wire carries the engine's own hypotheses, verbatim —
    // never two of them glued together.
    expect(r.interims).toEqual([FRAME_1, FRAME_2]);
    expect((r.interims.at(-1) as string).split('跟你说个').length - 1).toBe(1);

    r.eng.finalText = FRAME_2;
    await r.stop();
    expect(r.finals).toEqual([FRAME_2]);
  });

  it('POSITIVE CONTROL: a sentence genuinely said twice still arrives twice', async () => {
    // Both copies are INSIDE one cumulative frame (the recognizer heard both),
    // so replacement preserves the repetition — nothing here compares text for
    // similarity, so there is no mechanism that could collapse real speech
    // (dropped characters are a veto; same control INT-2 pinned for sherpa).
    const r = await rig('cumulative');
    r.eng.frame('跟你说个事');
    r.eng.frame('跟你说个事，跟你说个事。');
    expect((r.interims.at(-1) as string).split('跟你说个事').length - 1).toBe(2);

    r.eng.finalText = '跟你说个事，跟你说个事。';
    await r.stop();
    expect((r.finals.at(-1) as string).split('跟你说个事').length - 1).toBe(2);
  });
});

describe('REQ-14-01 — the asymmetry itself, pinned on the UNDECLARED fold', () => {
  /**
   * 🔴 THIS ROW IS THE DEFECT THE OWNER SAW, kept green ON PURPOSE.
   *
   * It pins what an engine that has NOT declared its interim shape gets from
   * `mergeOnlineDraft` on the measured frames: every branch declines (prefix 6
   * < 8; overlap 0; suffix 1×4 < 7) and the last line APPENDS — the preview
   * duplicates — while the terminal, built from the vendor final, is clean.
   * That pair of facts IS 「duplicates while held, does not after release」.
   *
   * Two reasons it stays rather than being 「fixed」:
   *   · it is the RESIDENT REVERSE CONTROL for the Soniox declaration — delete
   *     `interimShape` from SonioxEngine and production falls back into exactly
   *     this behaviour, which this row proves is a duplication;
   *   · six engines remain undeclared, and INT-2's ruling is that they keep
   *     this fold byte-for-byte until someone MEASURES their stream shape —
   *     re-tuning the guesser's thresholds on today's example is the same
   *     mistake that built it (text-merge.ts, the INT-2 block, says why).
   */
  it('undeclared + the same two frames = duplicated preview, clean terminal', async () => {
    const r = await rig(undefined);
    r.eng.frame(FRAME_1);
    r.eng.frame(FRAME_2);

    // The hold half: the opening clause is on the wire twice.
    expect(r.interims.at(-1)).toBe(FRAME_1 + FRAME_2);
    expect((r.interims.at(-1) as string).split('跟你说个').length - 1).toBe(2);

    // The release half: the vendor final replaces everything — clean.
    r.eng.finalText = FRAME_2;
    await r.stop();
    expect(r.finals).toEqual([FRAME_2]);
    expect((r.finals.at(-1) as string).split('跟你说个').length - 1).toBe(1);
  });
});
