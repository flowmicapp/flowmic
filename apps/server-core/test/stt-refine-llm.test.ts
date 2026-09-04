// The second pass as an LLM SMOOTHING pass (owner ruling 2026-09-04, 「二次改顺」)
// — src/stt/stt-refine-llm.ts.
//
// What each group is about:
//   · the PROMPT carries the scenario card (professions / domains / terms with
//     their aliases) and the language rule, because those are the two inputs
//     that make this pass better than a generic "make it nicer";
//   · the GUARDS reject rather than deliver a partial. A rejected pass sends
//     NOTHING: the user already has the delivered text on screen, so silence is
//     the honest outcome and a half-smoothed row is not.
//
// 🔴 REVERSE CONTROL for the guards is in-file and executed (see the `it` titled
// "reverse control"): the same LLM output that the SMOOTH profile accepts is fed
// to the STRICT profile, and it is refused. That is the measurement behind
// choosing `strength: 'smooth'` — the strict calibration was written for an
// in-place character correction, and deleting a filler plus repairing the
// grammar behind it IS a large character-level edit.

import { describe, expect, it } from 'vitest';
import type { LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import {
  REFINE_BUDGET_MS,
  refineFinalText,
  refineLanguageRule,
  refineSystemPrompt,
} from '../src/stt/stt-refine-llm';

const CFG: LlmConfig = {
  protocol: 'openai-compatible',
  endpoint: 'http://test.invalid/v1',
  api_key: 'EMPTY',
  model: 'test-model',
};

/** Captures the system + user strings the pass actually hands the model. */
function capturingStreamer(full: string): {
  streamerFor: (protocol: LlmProtocol) => LlmStreamer;
  seen: { system: string; user: string }[];
} {
  const seen: { system: string; user: string }[] = [];
  return {
    seen,
    streamerFor: (_protocol) => async function* (opts): AsyncGenerator<LlmEvent> {
      seen.push({ system: opts.system, user: opts.user });
      yield { kind: 'done', full };
    },
  };
}

const eventStreamer = (events: LlmEvent[]): ((p: LlmProtocol) => LlmStreamer) =>
  (_p) => async function* (): AsyncGenerator<LlmEvent> { for (const e of events) yield e; };

// A colloquial utterance and its smoothing. Chosen so the pair contains NO
// closed-class term (negation / numeral / quantifier / modal): §3.2 of the
// meaning guard is strength-INDEPENDENT, so a fixture that drops a 「一」 would
// be measuring the closed-class gate rather than the thing under test.
const SPOKEN = '嗯这个方案呢我们先做前面的部分吧';
const SMOOTHED = '这个方案我们先做前面的部分';

describe('refineSystemPrompt — what the model is told', () => {
  it('carries the scenario card, and the block comes FIRST (stable prefix)', () => {
    const block = 'BACKGROUND CONTEXT\nprofessions: radiologist\nterms: Rockstore (洛克斯托)';
    const p = refineSystemPrompt('zh', block);
    expect(p.startsWith(block)).toBe(true);
    expect(p).toContain('Rockstore');
    expect(p).toContain('BACKGROUND CONTEXT block precedes these rules');
  });

  it('no block ⇒ the task template alone, unchanged', () => {
    expect(refineSystemPrompt('zh', '')).toBe(refineSystemPrompt('zh'));
    expect(refineSystemPrompt('zh')).not.toContain('BACKGROUND CONTEXT block precedes');
  });

  it('says the three things the owner asked for: order, completeness, facts', () => {
    const p = refineSystemPrompt('en');
    expect(p).toContain('Keep the ORDER in which the speaker said things');
    expect(p).toContain('never drop a statement');
    expect(p).toContain('numbers, quantities, units, names, dates');
  });

  it('names a KNOWN language and still subordinates itself to the transcript', () => {
    const rule = refineLanguageRule('de');
    expect(rule).toContain('expected to be in German');
    expect(rule).toContain('follow the transcript and not this note');
    expect(refineSystemPrompt('de')).toContain('expected to be in German');
  });

  it('🔴 an UNKNOWN or absent language never becomes English (owner 2026-08-29)', () => {
    // English is the language WE speak when we have none of the user's — it is
    // never the language we rewrite the user INTO. So the silent form is the
    // answer, and the raw tag never reaches the model either (a tag is not a
    // word; telling a model to "write in xh" is worse than saying nothing).
    for (const tag of [undefined, 'auto', 'xh', '']) {
      const rule = refineLanguageRule(tag);
      expect(rule).toBe('Output in the same language as the transcript. Never translate.');
      expect(rule).not.toContain('English');
      expect(rule).not.toContain('xh');
    }
  });
});

describe('refineFinalText — the pass', () => {
  it('smooths the delivered text and hands back only the new text', async () => {
    const r = await refineFinalText(SPOKEN, CFG, { streamerFor: eventStreamer([{ kind: 'done', full: SMOOTHED }]) });
    expect(r.text).toBe(SMOOTHED);
    expect(r.reason).toBeUndefined();
  });

  it('🔴 the card terms and the whole utterance reach the model', async () => {
    const block = 'BACKGROUND CONTEXT\nterms: Rockstore (洛克斯托)';
    const cap = capturingStreamer(SMOOTHED);
    await refineFinalText(SPOKEN, CFG, {
      streamerFor: cap.streamerFor,
      scenarioBlock: block,
      protectedTerms: ['Rockstore'],
      language: 'zh',
    });
    expect(cap.seen).toHaveLength(1);
    expect(cap.seen[0]?.system).toContain('Rockstore');
    expect(cap.seen[0]?.system).toContain('Simplified Chinese');
    // The FULL utterance, not a segment of it — that is the whole difference
    // between this pass and the per-segment polish in front of delivery.
    expect(cap.seen[0]?.user).toBe(SPOKEN);
  });

  it('an LLM error delivers nothing and names the code', async () => {
    const r = await refineFinalText(SPOKEN, CFG, {
      streamerFor: eventStreamer([{ kind: 'error', code: 'LLM_TIMEOUT', message: 'x' }]),
    });
    expect(r.text).toBeNull();
    expect(r.reason).toBe('LLM_TIMEOUT');
  });

  it('an empty answer is a FAILED pass, never a blanked row', async () => {
    const r = await refineFinalText(SPOKEN, CFG, { streamerFor: eventStreamer([{ kind: 'done', full: '   ' }]) });
    expect(r.text).toBeNull();
    expect(r.reason).toBe('empty-output');
  });

  it('an echo of the input delivers nothing (never a no-op 「已优化」 signal)', async () => {
    const r = await refineFinalText(SPOKEN, CFG, { streamerFor: eventStreamer([{ kind: 'done', full: SPOKEN }]) });
    expect(r.text).toBeNull();
    expect(r.reason).toBe('no-change');
  });

  it('the budget is generous — nothing waits for this pass', () => {
    // Stated as an assertion rather than a comment because the number is the
    // whole reason the pass can run on a ten-minute dictation: polish sits IN
    // FRONT of delivery (2 s floor), this one sits behind it.
    expect(REFINE_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('the model reporting usage is passed back so the caller can bill it', async () => {
    const r = await refineFinalText(SPOKEN, CFG, {
      streamerFor: eventStreamer([{ kind: 'done', full: SMOOTHED, usage: { tokens_in: 11, tokens_out: 7 } }]),
    });
    expect(r.usage).toEqual({ tokensIn: 11, tokensOut: 7 });
  });
});

describe('refineFinalText — the guards, each of which delivers NOTHING', () => {
  it('a writing-system swap is refused', async () => {
    const r = await refineFinalText(SPOKEN, CFG, {
      streamerFor: eventStreamer([{ kind: 'done', full: 'Lets do the front part of this plan first' }]),
    });
    expect(r.text).toBeNull();
    expect(r.reason).toMatch(/^script-changed:/);
  });

  it('a summary is refused by the length band', async () => {
    const r = await refineFinalText(SPOKEN, CFG, { streamerFor: eventStreamer([{ kind: 'done', full: '先做前面' }]) });
    expect(r.text).toBeNull();
    expect(r.reason).toMatch(/^length-ratio:/);
  });

  it('an elaboration is refused by the length band', async () => {
    const padded = `${SMOOTHED}${'另外还要补充一些说明内容以及背景介绍和后续安排的细节'}${'再加上一段更长的补充说明用来撑开长度'}`;
    const r = await refineFinalText(SPOKEN, CFG, { streamerFor: eventStreamer([{ kind: 'done', full: padded }]) });
    expect(r.text).toBeNull();
    expect(r.reason).toMatch(/^length-ratio:/);
  });

  it('🔴 a flipped negation is refused — smoothing never touches the closed class', async () => {
    const spoken = '这个方案我们先做前面的部分';
    const flipped = '这个方案我们不做前面的部分';
    const r = await refineFinalText(spoken, CFG, { streamerFor: eventStreamer([{ kind: 'done', full: flipped }]) });
    expect(r.text).toBeNull();
    expect(r.reason).toBe('closed-class-drift:不');
  });

  it('🔴 dropping a term the user declared is refused — a pass may not undo their settings', async () => {
    const spoken = '把数据都存在 Rockstore 里面然后我们再看';
    const dropped = '把数据存在里面然后我们再看';
    const r = await refineFinalText(spoken, CFG, {
      protectedTerms: ['Rockstore'],
      streamerFor: eventStreamer([{ kind: 'done', full: dropped }]),
    });
    expect(r.text).toBeNull();
    expect(r.reason).toBe('dict-term-drift:Rockstore');
  });
});

describe('🔴 reverse control — why the SMOOTH profile and not the strict one', () => {
  it('the very edit this pass exists to make is REFUSED by the strict calibration', () => {
    // The pass delivers this pair (proven above). Feed the same pair to the
    // guard at `strict` — the profile the per-utterance polish uses by default —
    // and it comes back refused. A guard tuned to reject the work it is
    // guarding is a guard nobody keeps, which is why `strength` exists and why
    // this pass passes 'smooth'.
    const strict = checkMeaningPreserved(SPOKEN, SMOOTHED, { strength: 'strict' });
    const smooth = checkMeaningPreserved(SPOKEN, SMOOTHED, { strength: 'smooth' });
    expect(strict.ok).toBe(false);
    // MEASURED, not assumed: the axis strict trips on for THIS pair is the
    // open-class cardinality budget (K=2 at strict, 12 at smooth), not the edit
    // distance. Quoted rather than loosened to `ok === false`, so a future
    // recalibration that moves the reason has to come back through this line.
    expect(strict.reason).toBe('open-class-delta-exceeded');
    expect(smooth.ok).toBe(true);
  });
});
