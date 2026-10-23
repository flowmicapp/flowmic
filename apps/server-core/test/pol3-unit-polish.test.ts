// Card POL-3 — unit polish with read-only context from earlier rows (design
// docs/strategy/2026-10-14-two-stage-polish-design.md §2, §5, §10 row POL-3;
// contract book 06 §5, POL-0 block). Tests T1 T2 T3 T6 T7 T9 T12 T14 T15 on the
// REAL bridge + orchestrator (only the engine and the LLM streamer are doubled,
// test/pol3-harness.ts). The stage-1 hold cap (T4, T5) is in pol3-hold-cap.test.ts;
// the switch (T13) in pol3-stages-env.test.ts; the shared join fixture in
// pol3-unit-join-shared.test.ts.
//
// Each 🔴 case names its reverse control: the edit that must turn it red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { __resetPolishCacheForTest, POLISH_SYSTEM_PROMPT } from '../src/stt/stt-polish';
import { contextSystemPrompt, seamEcho, UNIT_CONTEXT_RULE, UNIT_DICTATED_PUNCT_RULE, UNIT_OPEN_END_RULE } from '../src/stt/stt-polish-piece';
import { contextForUnit, UNIT_CONTEXT_MAX, unitPolishFor } from '../src/engine/stt-session-units';
import { keepOpenEnd } from '../src/stt/seam-artifact';

/** The ONE stage-1 strip (SEAM-2's), as a context-mode stage-1 row calls it: the row is open. */
const strip = (input: string, output: string, language?: string): string => keepOpenEnd(input, output, true, language);
import { contextOf, press, scriptedLlm, sleep, unitOf, type Reply } from './pol3-harness';

const CONTEXT = { polishStages: 'context' as const };
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** The default model: capitalises the unit's first letter (accepted by the strict guard). */
const capitalise = (unit: string): Reply => ({ full: upperFirst(unit), usage: { tokens_in: 10, tokens_out: 5 } });

const S0 = 'we looked at the numbers yesterday';
const S1 = 'and the margin went up again';
const TAIL = 'so we ship on friday';

describe('card POL-3 — unit polish with read-only context', () => {
  const infos: { msg: string; fields: Record<string, unknown> }[] = [];
  beforeEach(() => {
    __resetPolishCacheForTest(); infos.splice(0);
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { infos.push({ msg, fields: fields ?? {} }); });
  });
  afterEach(() => vi.restoreAllMocks());
  const polishFinals = (): Record<string, unknown>[] => infos.filter((l) => l.msg === 'stt.polish.final').map((l) => l.fields);

  /** A press cut into two rows plus the tail, each final arriving after the
   *  previous row was sent. */
  async function cutPress(extra = {}, reply: (u: string, n: number) => Reply = capitalise, polishDeps = {}) {
    const llm = scriptedLlm(reply);
    const rig = await press(llm.streamerFor, extra, polishDeps);
    rig.segment(0, S0); await sleep(40);
    rig.segment(1, S1); await sleep(40);
    await rig.release(TAIL);
    return { llm, rig };
  }

  it('🔴 T1 row N≥1 and the tail carry the frozen text of the rows before them (reverse: send "" as context)', async () => {
    const { llm } = await cutPress(CONTEXT);
    expect(llm.calls.map((c) => unitOf(c.user))).toEqual([S0, S1, TAIL]);
    expect(contextOf(llm.calls[0]!.user)).toBe('');
    expect(contextOf(llm.calls[1]!.user)).toBe(upperFirst(S0));
    expect(contextOf(llm.calls[2]!.user)).toBe(`${upperFirst(S0)} ${upperFirst(S1)}`);
    // Stage 1 carries the open-end rule, stage 2 does not; both carry the unit rule.
    expect(llm.calls[1]!.system).toBe(`${POLISH_SYSTEM_PROMPT}\n${UNIT_CONTEXT_RULE}\n${UNIT_OPEN_END_RULE} ${UNIT_DICTATED_PUNCT_RULE}`); // no language ⇒ the English table
    expect(llm.calls[2]!.system).toBe(`${POLISH_SYSTEM_PROMPT}\n${UNIT_CONTEXT_RULE}`);
    // POL-1 fields now have a writer: measured in code points, U0 measured as 0.
    expect(polishFinals().map((r) => [r.stage, r.ctx_chars, r.ctx_pending])).toEqual([
      ['segment', 0, false], ['segment', [...upperFirst(S0)].length, false], ['tail', [...`${upperFirst(S0)} ${upperFirst(S1)}`].length, false],
    ]);
  });

  it('🔴 T2 an uncut press, and the first row of a cut press, send today\'s request byte for byte (reverse: frame every request with the unit rule)', async () => {
    const legacyUncut = scriptedLlm(capitalise);
    await (await press(legacyUncut.streamerFor)).release(TAIL);
    __resetPolishCacheForTest();
    const contextUncut = scriptedLlm(capitalise);
    await (await press(contextUncut.streamerFor, CONTEXT)).release(TAIL);
    expect(contextUncut.calls).toHaveLength(1);
    // Same model + same system + same user ⇒ the same cache key: stt-polish.ts
    // `cacheKey(cfg.model, system, piece.user)` reads nothing else.
    expect(contextUncut.calls.map((c) => [c.system, c.user])).toEqual(legacyUncut.calls.map((c) => [c.system, c.user]));
    expect(contextUncut.calls[0]!.system).toBe(POLISH_SYSTEM_PROMPT);
    expect(contextUncut.calls[0]!.user).toBe(TAIL);

    __resetPolishCacheForTest();
    const { llm: legacyCut } = await cutPress();
    __resetPolishCacheForTest();
    const { llm: contextCut } = await cutPress(CONTEXT);
    expect([contextCut.calls[0]!.system, contextCut.calls[0]!.user]).toEqual([legacyCut.calls[0]!.system, legacyCut.calls[0]!.user]);
  });

  it('🔴 T3 the context is the text ON THE FRAME: polished when accepted, raw when skipped (reverse: always use the raw text)', async () => {
    // Row 0 accepted ⇒ the next request reads the capitalised frame text.
    const { llm, rig } = await cutPress(CONTEXT);
    const frames = rig.finals();
    expect(frames[0]!.text).toBe(upperFirst(S0));
    expect(contextOf(llm.calls[1]!.user)).toBe(frames[0]!.text);
    expect(contextOf(llm.calls[1]!.user)).not.toBe(S0);

    // Row 0 refused by the guard ⇒ its frame carries the raw text, and so does the next context.
    __resetPolishCacheForTest();
    const refuseFirst = (u: string, n: number): Reply => (n === 0 ? { full: 'Totally different words about lunch instead of numbers', usage: { tokens_in: 9, tokens_out: 9 } } : capitalise(u));
    const second = await cutPress(CONTEXT, refuseFirst);
    const f2 = second.rig.finals();
    expect([f2[0]!.text, f2[0]!.polish, f2[0]!.polish_reason]).toEqual([S0, 'skipped', 'guard_reject']);
    expect(contextOf(second.llm.calls[1]!.user)).toBe(S0);
  });

  describe('T6 stage 1 strips a terminal mark it added', () => {
    it('the pure rule (the one implementation, seam-artifact keepOpenEnd): an added "."/"。" ⇒ stripped (closers kept); already there ⇒ kept; ?/! never', () => {
      expect(strip('and then we went', 'And then we went.')).toBe('And then we went');
      expect(strip('他说 安倍', '他说安倍。')).toBe('他说安倍');
      expect(strip('he said "wait', 'He said "wait."')).toBe('He said "wait"');
      expect(strip('really', 'Really?!')).toBe('Really?!'); // SEAM-2: never ?/!/… — the model wrote a real question
      expect(strip('it works.', 'It works.')).toBe('It works.');
      expect(strip('is it?', 'Is it?')).toBe('Is it?');
      expect(strip('and then', 'And then')).toBe('And then');
      expect(strip('x', '.')).toBe('.'); // never empties a row
    });

    it('🔴 a DICTATED end mark is the speaker\'s and is kept; the same word as a noun is not a command (reverse: drop the dictation check)', () => {
      expect(strip('send the report period', 'Send the report.', 'en')).toBe('Send the report.');
      expect(strip('are you coming question mark', 'Are you coming?', 'en')).toBe('Are you coming?');
      expect(strip("c'est fini point", "C'est fini.", 'fr')).toBe("C'est fini.");
      expect(strip('we are in the trial period', 'We are in the trial period.', 'en')).toBe('We are in the trial period');
      expect(strip('add a comma here', 'Add a comma here.', 'en')).toBe('Add a comma here');
    });

    it('🔴 NR-262: an unpaired `added` phrase is a word, not a dictated mark (reverse: drop the added test)', () => {
      expect(strip('se acabó punto', 'Se acabó.', 'es')).toBe('Se acabó.');
      expect(strip('se acabó punto final', 'Se acabó.', 'es')).toBe('Se acabó');
    });

    it('🔴 on the bridge: a row ending in a dictated "period" keeps its period and says applied (reverse: drop the dictation check)', async () => {
      const llm = scriptedLlm((u) => ({ full: u === 'send the report period' ? 'Send the report.' : upperFirst(u), usage: { tokens_in: 1, tokens_out: 1 } }));
      const rig = await press(llm.streamerFor, CONTEXT, { language: 'en' });
      rig.segment(0, 'send the report period'); await sleep(40);
      await rig.release('and done');
      expect([rig.finals()[0]!.text, rig.finals()[0]!.polish]).toEqual(['Send the report.', 'applied']);
      expect(llm.calls[0]!.system).toBe(POLISH_SYSTEM_PROMPT); // row 0 still sends today's request
    });

    it('🔴 re-review 4: the dictated-punctuation sentence is only sent for a language with a dictation table (reverse: always send it)', () => {
      expect(UNIT_DICTATED_PUNCT_RULE).toMatch(/dictated/);
      expect(UNIT_OPEN_END_RULE).not.toMatch(/dictated/);
      for (const lang of ['en', 'fr', 'de', 'es', 'ru', 'ja', 'ko', undefined]) {
        expect(contextSystemPrompt('BASE', 'unit-open', lang), String(lang)).toContain(UNIT_DICTATED_PUNCT_RULE);
      }
      expect(contextSystemPrompt('BASE', 'unit-open', 'zh')).toBe(`BASE\n${UNIT_CONTEXT_RULE}\n${UNIT_OPEN_END_RULE}`);
      expect(contextSystemPrompt('BASE', 'unit', 'en')).toBe(`BASE\n${UNIT_CONTEXT_RULE}`);
    });

    it('🔴 on the bridge: a segment row loses the added period, a segment that had one keeps it, the tail keeps its period (reverse: delete the strip)', async () => {
      const llm = scriptedLlm((u) => ({ full: upperFirst(u.endsWith('.') ? u : `${u}.`), usage: { tokens_in: 1, tokens_out: 1 } }));
      const rig = await press(llm.streamerFor, CONTEXT);
      rig.segment(0, 'and then we went'); await sleep(40);
      rig.segment(1, 'it works.'); await sleep(40);
      await rig.release('and done');
      expect(rig.finals().map((f) => [f.text, f.polish])).toEqual([
        ['And then we went', 'applied'], ['It works.', 'applied'], ['And done.', 'applied'],
      ]);
      // The frozen text is the stripped one: the tail's context reads it.
      expect(contextOf(llm.calls[2]!.user)).toBe('And then we went It works.');
    });
  });

  it('🔴 T7 an output that repeats the context is refused (context-echo → guard_reject) (reverse: delete the contextEcho check in stt-polish.ts)', async () => {
    const CTX_ROW = 'We looked at the numbers yesterday. The margin went up.';
    const PIECE = 'so the next thing is the forecast for the third quarter';
    const reply = (u: string): Reply => (u === CTX_ROW
      ? { full: CTX_ROW, usage: { tokens_in: 1, tokens_out: 1 } }
      : { full: `The margin went up. ${upperFirst(PIECE)}.`, usage: { tokens_in: 1, tokens_out: 1 } });
    const llm = scriptedLlm(reply);
    const rig = await press(llm.streamerFor, CONTEXT, { strength: 'smooth' });
    rig.segment(0, CTX_ROW); await sleep(40);
    await rig.release(PIECE);
    expect(contextOf(llm.calls[1]!.user)).toBe(CTX_ROW);
    const tail = rig.finals()[1]!;
    expect([tail.text, tail.polish, tail.polish_reason]).toEqual([PIECE, 'skipped', 'guard_reject']);
  });

  describe('fix 5: a partial echo across the seam', () => {
    const CTX_ROW = 'we walked all the way down to the';
    it('the pure check, both directions', () => {
      expect(seamEcho(CTX_ROW, 'harbour and it was quiet', 'To the harbour and it was quiet')).toBe(true);
      expect(seamEcho(CTX_ROW, 'harbour and it was quiet', 'The harbour and it was quiet')).toBe(true);
      expect(seamEcho(CTX_ROW, 'harbour and it was quiet', 'Down to the harbour, and it was quiet')).toBe(true);
      // The raw text genuinely starts with those words ⇒ not an echo.
      expect(seamEcho(CTX_ROW, 'the harbour and it was quiet', 'The harbour and it was quiet')).toBe(false);
      expect(seamEcho(CTX_ROW, 'to the harbour we went', 'To the harbour we went')).toBe(false);
      expect(seamEcho(CTX_ROW, 'harbour and it was quiet', 'Harbour and it was quiet')).toBe(false);
      expect(seamEcho('', 'the end', 'The end')).toBe(false);
    });

    it('🔴 re-review 1: a rewrite that merely STARTS with the last context word is not an echo (reverse: drop the "row first word follows" test)', () => {
      expect(seamEcho('we should ask Anna', 'ana said yes', 'Anna said yes')).toBe(false); // name correction
      expect(seamEcho('the number is 3', 'three is fine', '3 is fine')).toBe(false); // number rewrite
      expect(seamEcho('we will see', 'so see you all tomorrow', 'See you all tomorrow')).toBe(false); // filler dropped
      expect(seamEcho(CTX_ROW, 'harbour and it was quiet', 'To the harbour and it was quiet')).toBe(true); // still refused
    });

    it('🔴 re-review 2: rows without spaces take the character path (reverse: route zh/ja to the word path)', () => {
      const ZH_CTX = '我们一直走，最后走到了';
      expect(seamEcho(ZH_CTX, '港口很安静', '到了港口很安静')).toBe(true);
      expect(seamEcho(ZH_CTX, '港口很安静', '走到了港口很安静。')).toBe(true);
      expect(seamEcho(ZH_CTX, '到了港口很安静', '到了港口很安静')).toBe(false); // the row really starts there
      expect(seamEcho(ZH_CTX, '港口很安静', '港口很安静。')).toBe(false);
      expect(seamEcho('駅まで歩いて行きました', 'ました。そして', 'ました。そして')).toBe(false);
      expect(seamEcho('駅まで歩いて', '電車に乗りました', '歩いて電車に乗りました')).toBe(true);
      // Hangul is spaced: the word path.
      expect(seamEcho('우리는 항구까지', '걸어갔어요', '항구까지 걸어갔어요')).toBe(true);
      expect(seamEcho('우리는 항구까지', '항구까지 걸어갔어요', '항구까지 걸어갔어요')).toBe(false);
    });

    it('🔴 on the bridge: the tail that re-says the dangling "to the" is refused (raw + guard_reject); one that really starts there passes (reverse: drop the seam check)', async () => {
      const reply = (u: string): Reply => (u === CTX_ROW ? { full: CTX_ROW, usage: { tokens_in: 1, tokens_out: 1 } }
        : u === 'harbour and it was quiet' ? { full: 'To the harbour and it was quiet', usage: { tokens_in: 1, tokens_out: 1 } }
        : { full: upperFirst(u), usage: { tokens_in: 1, tokens_out: 1 } });
      const llm = scriptedLlm(reply);
      const rig = await press(llm.streamerFor, CONTEXT, { strength: 'smooth' });
      rig.segment(0, CTX_ROW); await sleep(40);
      await rig.release('harbour and it was quiet');
      expect(rig.finals().map((f) => [f.text, f.polish, f.polish_reason ?? null])).toEqual([
        [CTX_ROW, 'applied', null], ['harbour and it was quiet', 'skipped', 'guard_reject'],
      ]);
      __resetPolishCacheForTest();
      const ok = scriptedLlm(reply);
      const rig2 = await press(ok.streamerFor, CONTEXT, { strength: 'smooth' });
      rig2.segment(0, CTX_ROW); await sleep(40);
      await rig2.release('to the harbour we went');
      expect(rig2.finals()[1]).toMatchObject({ text: 'To the harbour we went', polish: 'applied' });
    });
  });

  it('🔴 T9 released while the previous row is still polishing: the tail goes at once, with that row\'s RAW text as context (reverse: wait for the row)', async () => {
    const llm = scriptedLlm((u) => (u === S0 ? { ...capitalise(u), delayMs: 1_200 } : capitalise(u)));
    const rig = await press(llm.streamerFor, CONTEXT);
    rig.segment(0, S0);
    await sleep(20);
    await rig.release(TAIL);
    const [row, tail] = llm.calls;
    expect(tail!.at).toBeLessThan(row!.answeredAt!); // sent before row 0 was answered
    expect(contextOf(tail!.user)).toBe(S0); // raw, not "We looked…"
    expect(polishFinals().find((r) => r.stage === 'tail')).toMatchObject({ ctx_pending: true, ctx_chars: [...S0].length });
    // Row 0 still leaves first, polished (T15 order).
    expect(rig.finals().map((f) => f.text)).toEqual([upperFirst(S0), upperFirst(TAIL)]);
  });

  describe('T12 legacy, continuous recordings and recovery legs are unchanged', () => {
    const shape = (calls: { system: string; user: string }[]) => calls.map((c) => [c.system, c.user]);
    const POL1_FIELDS = ['ctx_chars', 'ctx_pending', 'hold_cap_hit'] as const;

    it('🔴 legacy (switch absent): no request carries context and no unit field is written (reverse: arm the units without the switch)', async () => {
      const { llm } = await cutPress();
      expect(shape(llm.calls)).toEqual([[POLISH_SYSTEM_PROMPT, S0], [POLISH_SYSTEM_PROMPT, S1], [POLISH_SYSTEM_PROMPT, TAIL]]);
      for (const r of polishFinals()) for (const k of POL1_FIELDS) expect(k in r, k).toBe(false);
    });

    for (const [name, extra] of [['continuous', { continuous: true }], ['recovery leg', { recoveryLeg: true }]] as const) {
      it(`🔴 ${name} under context: the same requests and the same polish records as legacy (reverse: drop the SEG-1 contract test from unitPolishFor)`, async () => {
        const { llm: legacy } = await cutPress(extra);
        const legacyFinals = polishFinals().map((r) => Object.keys(r).sort());
        infos.splice(0); __resetPolishCacheForTest();
        const { llm: ctx } = await cutPress({ ...CONTEXT, ...extra });
        expect(shape(ctx.calls)).toEqual(shape(legacy.calls));
        expect(polishFinals().map((r) => Object.keys(r).sort())).toEqual(legacyFinals);
        for (const r of polishFinals()) for (const k of POL1_FIELDS) expect(k in r, k).toBe(false);
      });
    }

    it('the arming table: every condition is required', () => {
      const polish = { llm: { cfg: { protocol: 'openai-compatible', endpoint: 'x', api_key: 'x', model: 'x' }, source: 'user' } } as never;
      const on = { polishStages: 'context' as const, polish };
      expect(unitPolishFor(on)).not.toBeNull();
      expect(unitPolishFor({ ...on, polishStages: undefined })).toBeNull();
      expect(unitPolishFor({ ...on, polish: undefined })).toBeNull();
      expect(unitPolishFor({ ...on, polishDelivery: 'detached' })).toBeNull();
      expect(unitPolishFor({ ...on, polishSpeculative: true })).toBeNull();
      expect(unitPolishFor({ ...on, continuous: true })).toBeNull();
      expect(unitPolishFor({ ...on, recoveryLeg: true })).toBeNull();
    });
  });

  it('🔴 T14 no internal field reaches a frame: every stt:final carries exactly the legacy keys (reverse: put ctx_chars into the frame rest)', async () => {
    const { rig: legacy } = await cutPress();
    const legacyKeys = legacy.finals().map((f) => Object.keys(f).sort());
    __resetPolishCacheForTest();
    const { rig } = await cutPress(CONTEXT);
    expect(rig.finals().map((f) => Object.keys(f).sort())).toEqual(legacyKeys);
    for (const f of rig.frames) {
      for (const k of ['context', 'ctx_chars', 'ctx_pending', 'stage', 'hold_cap_hit', 'contextRule']) expect(k in f.payload, `${f.ev}.${k}`).toBe(false);
    }
  });

  it('🔴 T15 the ordered outbox order is unchanged: a later row that answers first still leaves after the slow row, and so does the interim between them (reverse: emit the row outside its reserved slot)', async () => {
    // Row 0 answers at 300 ms; row 1 arrives at 100 ms and answers at ~110 ms.
    const llm = scriptedLlm((u) => (u === S0 ? { ...capitalise(u), delayMs: 300 } : capitalise(u)));
    const rig = await press(llm.streamerFor, CONTEXT);
    rig.segment(0, S0);
    rig.interim(1, 'and the mar');
    await sleep(100);
    rig.segment(1, S1);
    await sleep(400);
    await rig.release(TAIL);
    const order = rig.frames.filter((f) => f.ev === 'stt:final' || f.ev === 'stt:interim').map((f) => `${f.ev}:${String(f.payload.text)}`);
    expect(order).toEqual([`stt:final:${upperFirst(S0)}`, 'stt:interim:and the mar', `stt:final:${upperFirst(S1)}`, `stt:final:${upperFirst(TAIL)}`]);
    // Row 1 was not held back for row 0's answer: it went with row 0's RAW text (F7, stage 1 too).
    expect(contextOf(llm.calls[1]!.user)).toBe(S0);
    expect(polishFinals().filter((r) => r.stage === 'segment').map((r) => r.ctx_pending)).toEqual([false, true]);
  });
});

describe('card POL-3 — contextForUnit (pure)', () => {
  const row = (raw: string, frozen: string | null = raw) => ({ raw, frozen });

  it('frozen text wins over raw; a row still polishing contributes its raw text and marks pending', () => {
    expect(contextForUnit([row('a b', 'A b.'), row('c d', null)])).toEqual({ text: 'A b. c d', pending: true });
    expect(contextForUnit([row('一二', '一二。'), row('三四')])).toEqual({ text: '一二。\n三四', pending: false });
    expect(contextForUnit([])).toEqual({ text: '', pending: false });
  });

  it(`🔴 at most UNIT_CONTEXT_MAX (${UNIT_CONTEXT_MAX}) code points, the start moved to the next sentence start (reverse: drop the cap)`, () => {
    const sentence = 'This sentence has exactly fifty code points in it. '; // 51 with the space
    const long = sentence.repeat(30).trim();
    const out = contextForUnit([row(long)]);
    expect([...out.text].length).toBeLessThanOrEqual(UNIT_CONTEXT_MAX);
    expect(out.text.startsWith('This sentence')).toBe(true);
    expect(long.endsWith(out.text)).toBe(true);
  });

  it('no sentence start inside the window ⇒ the plain code-point cut (astral characters counted once)', () => {
    const run = '😀'.repeat(UNIT_CONTEXT_MAX + 10);
    const out = contextForUnit([row(run)]);
    expect([...out.text].length).toBe(UNIT_CONTEXT_MAX);
  });

  it('a pending row that fell out of the window does not mark the context pending', () => {
    const long = 'Done here. '.repeat(100).trim();
    expect(contextForUnit([row('early words', null), row(long)]).pending).toBe(false);
  });
});

describe('card POL-3 × SEAM-2 — context-mode rows feed the delivered-seam reader the same way', () => {
  beforeEach(() => { __resetPolishCacheForTest(); vi.spyOn(log, 'info').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  it('🔴 a context-mode row delivered without a final mark lets the next row continue in lower case (reverse: emit the row outside the bridge exit)', async () => {
    const llm = scriptedLlm((u) => ({ full: u === 'we went down to the' ? 'We went down to the.' : u, usage: { tokens_in: 1, tokens_out: 1 } }));
    const rig = await press(llm.streamerFor, CONTEXT);
    rig.segmentWith({ text: 'we went down to the', segment_idx: 0, seam_open: true }); await sleep(40);
    rig.segmentWith({ text: 'And then we left', segment_idx: 1, seam_from: 0 }); await sleep(40);
    await rig.release('done');
    expect(rig.finals()[0]!.text).toBe('We went down to the'); // the one strip (keepOpenEnd) took the added "."
    expect(unitOf(llm.calls[1]!.user)).toBe('and then we left'); // DeliveredSeam read row 0 as delivered
  });
});
