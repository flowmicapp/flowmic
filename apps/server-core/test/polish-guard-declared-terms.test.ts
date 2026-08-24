// THE GUARD MUST NOT REFUSE THE CORRECTION THE USER ASKED FOR.
//
// Measured 2026-08-24 against the production DeepSeek line, with the scenario
// block carrying the user's own term list (report:
// .local/pipeline-probe/polish-context-eval.json):
//
//   said   这批数据都存在洛克斯托里面
//   model  这批数据都存在Rockstore里面      ← exactly right, and 'Rockstore' is
//                                            a term the user typed into settings
//   guard  edit-distance-exceeded          ← thrown away
//
// A second cell in the same run (smooth + context) was refused as
// `length-ratio-exceeded`. 🔴 WHAT THE MODEL ACTUALLY RETURNED THERE IS NOT IN
// THE REPORT, and that is a hole in the instrument, not evidence: on a
// rejection `polishFinalText` returns the KEPT (pure) text, so the report
// records the input. The model's own bytes are in the pipeline trace
// (`polish.response`, which is written before the verdict for exactly this
// reason) and were not captured on that run. So this file asserts the
// Rockstore pair, which WAS measured end to end, and does not invent the other.
//
// The budget was not wrong about the DISTANCE — four Han characters becoming
// nine Latin ones IS a large character-level edit. It was wrong about what that
// distance MEANT. So the fix discounts the user's declared vocabulary from the
// budget instead of widening the budget: the measured calibration does not move
// by a digit, and the most a model can gain is the words the user already asked
// for.
//
// 🔴 The REVERSE CONTROLS are the substance of this file. An allowance that
// applied to any term, or that survived the terms being absent, would be a
// blanket loosening wearing a targeted costume.

import { describe, expect, it } from 'vitest';

import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';

const SAID_ROCK = '这批数据都存在洛克斯托里面';
const GOT_ROCK = '这批数据都存在Rockstore里面';
const SAID_FM = '打开飞麦克然后开始录音';
const GOT_FM = '打开FlowMic然后开始录音';

describe('polish guard — a declared term is not drift', () => {
  it('REVERSE CONTROL: without the declared term, the real measured rejections stand', () => {
    // The state that shipped, reproduced. If this ever goes green on its own,
    // the allowance stopped being the thing that admits the pair and every
    // assertion below is measuring nothing.
    const rock = checkMeaningPreserved(SAID_ROCK, GOT_ROCK, { strength: 'strict' });
    expect(rock.ok).toBe(false);
    expect(rock.reason).toBe('edit-distance-exceeded');

  });

  it('with the term declared, the same correction is admitted', () => {
    expect(checkMeaningPreserved(SAID_ROCK, GOT_ROCK, {
      strength: 'strict', declaredTerms: ['Rockstore'],
    }).ok).toBe(true);

    // The FlowMic pair is the one the live run ADMITTED at strict with context
    // on (it was a HIT). It must stay admitted — the allowance may only widen
    // what is accepted, never narrow it.
    expect(checkMeaningPreserved(SAID_FM, GOT_FM, {
      strength: 'strict', declaredTerms: ['FlowMic'],
    }).ok).toBe(true);
    expect(checkMeaningPreserved(SAID_FM, GOT_FM, { strength: 'strict' }).ok).toBe(true);
  });

  it('REVERSE CONTROL: an UNRELATED declared term buys nothing', () => {
    // The allowance is keyed on the term actually appearing in the output. A
    // list that granted budget just by being non-empty would be a free pass.
    const v = checkMeaningPreserved(SAID_ROCK, GOT_ROCK, {
      strength: 'strict', declaredTerms: ['Kubernetes', 'Docker'],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('edit-distance-exceeded');
  });

  it('REVERSE CONTROL: a term already present in the INPUT buys nothing', () => {
    // It was never part of the delta. Granting budget for it would hand out
    // allowance for work nobody did.
    const said = '这批数据都存在Rockstore里面';
    const rewritten = '完全不同的一句话彻底改写了内容和意思';
    expect(checkMeaningPreserved(said, rewritten, {
      strength: 'strict', declaredTerms: ['Rockstore'],
    }).ok).toBe(false);
  });

  it('the allowance can NEVER license a closed-class flip — §3.2 is untouched', () => {
    // Negation is the most damaging thing a correction pass can do, and no
    // amount of declared vocabulary may pay for it.
    const said = '这个数据没有存在Rockstore里面';
    const flipped = '这个数据存在Rockstore里面';
    const v = checkMeaningPreserved(said, flipped, {
      strength: 'strict', declaredTerms: ['Rockstore'],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/^closed-class-drift:/);
  });

  it('the allowance is bounded by the TERM length, not by the size of the rewrite', () => {
    // Same declared term, but the output also rewrote everything else. The
    // allowance covers 'Rockstore' and nothing more, so the rest still counts.
    const wild = '这批数据都存在Rockstore里面而且我们还讨论了预算排期和人力三件事';
    expect(checkMeaningPreserved(SAID_ROCK, wild, {
      strength: 'strict', declaredTerms: ['Rockstore'],
    }).ok).toBe(false);
  });

  it('an empty / absent term list is bit-for-bit the legacy calibration', () => {
    for (const opts of [{ strength: 'strict' as const }, { strength: 'strict' as const, declaredTerms: [] }]) {
      const v = checkMeaningPreserved(SAID_ROCK, GOT_ROCK, opts);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('edit-distance-exceeded');
    }
  });
});
