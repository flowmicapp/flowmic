// Card POL-3 — the stage-1 hold cap (design docs/strategy/2026-10-14-two-stage-
// polish-design.md §2.6 D5, §5.1, §7 F1; owner ruling 2026-08-07 ②; contract book
// 06 §5 POL-0 block). Tests T4 and T5 run on REAL timers against the REAL constant
// `SEGMENT_HOLD_CAP_MS` (2 s): a test seam for the cap would prove a number we chose
// for the test, not the one production runs with. ~3 s per case.
//
// Each 🔴 case names its reverse control: the edit that must turn it red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { SEGMENT_HOLD_CAP_MS } from '../src/engine/stt-session-units';
import { contextOf, press, scriptedLlm, sleep, type Reply } from './pol3-harness';

const CONTEXT = { polishStages: 'context' as const };
const S0 = 'we looked at the numbers yesterday';
const S1 = 'and the margin went up again';
const TAIL = 'so we ship on friday';
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const USAGE = { tokens_in: 10, tokens_out: 5 };

describe('card POL-3 — stage 1 waits at most SEGMENT_HOLD_CAP_MS', () => {
  const infos: { msg: string; fields: Record<string, unknown> }[] = [];
  const warns: { msg: string; fields: Record<string, unknown> }[] = [];
  beforeEach(() => {
    __resetPolishCacheForTest(); infos.splice(0); warns.splice(0);
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { infos.push({ msg, fields: fields ?? {} }); });
    vi.spyOn(log, 'warn').mockImplementation((msg: string, fields?: Record<string, unknown>) => { warns.push({ msg, fields: fields ?? {} }); });
  });
  const timings = (): Record<string, unknown>[] => infos.filter((l) => l.msg === 'stt.polish.timing').map((l) => l.fields);
  const LATE = 'stt.polish late_after_cap — answer not used, the row already left raw';
  afterEach(() => vi.restoreAllMocks());
  const polishFinals = (): Record<string, unknown>[] => infos.filter((l) => l.msg === 'stt.polish.final').map((l) => l.fields);

  it('the constant is the owner\'s 2 s', () => {
    expect(SEGMENT_HOLD_CAP_MS).toBe(2_000);
  });

  it('🔴 T5 a model that drags 3 s: the row leaves at 2 s with the raw text, the next interim follows it, the cancelled request is not metered (reverse: remove the cap)', async () => {
    // Row 0 drags and honours the abort (no usage, as the real transports do); the tail answers.
    const llm = scriptedLlm((u): Reply => (u === S0 ? { full: upperFirst(u), usage: USAGE, delayMs: 3_000 } : { full: upperFirst(u), usage: USAGE }));
    const rig = await press(llm.streamerFor, CONTEXT);
    const cutAt = Date.now();
    rig.segment(0, S0);
    rig.interim(1, 'and the mar');
    await sleep(2_300);
    const row0 = rig.frames.find((f) => f.ev === 'stt:final');
    expect(row0, 'row 0 must have left by 2.3 s').toBeDefined();
    expect(row0!.at - cutAt).toBeGreaterThanOrEqual(SEGMENT_HOLD_CAP_MS - 20);
    expect(row0!.at - cutAt).toBeLessThan(SEGMENT_HOLD_CAP_MS + 250);
    expect([row0!.payload.text, row0!.payload.polish, row0!.payload.polish_reason]).toEqual([S0, 'skipped', 'timeout']);
    // The next row's interim was held behind row 0 and released right after it.
    const order = rig.frames.filter((f) => f.ev === 'stt:final' || f.ev === 'stt:interim').map((f) => f.ev);
    expect(order).toEqual(['stt:final', 'stt:interim']);
    expect(llm.calls[0]!.aborted()).toBe(true);
    await rig.release(TAIL);
    // Metering: only the answered tail. The cancelled row reported no usage ⇒ nothing recorded.
    expect(rig.usage).toEqual([{ tokensIn: 10, tokensOut: 5 }]);
    expect(polishFinals().find((r) => r.stage === 'segment')).toMatchObject({ hold_cap_hit: true, ctx_chars: 0 });
    // The tail reads row 0 as its frame carried it: raw.
    expect(contextOf(llm.calls[1]!.user)).toBe(S0);
  }, 10_000);

  it('🔴 observability: a cap-cancelled request is a TIMEOUT in stt.polish.timing, and its late cancelled answer is an info line, not a WARN (reverse: drop the after-cap mapping; reverse: drop the WARN suppression)', async () => {
    const llm = scriptedLlm((u): Reply => (u === S0 ? { full: upperFirst(u), delayMs: 3_000 } : { full: upperFirst(u), usage: USAGE }));
    const rig = await press(llm.streamerFor, CONTEXT);
    rig.segment(0, S0);
    await sleep(2_300);
    await rig.release(TAIL);
    const [seg, tail] = timings();
    expect([seg!.is_segment, seg!.outcome, seg!.after_hold_cap, seg!.late_outcome]).toEqual([true, 'timeout', true, 'cancelled']);
    expect([tail!.is_segment, tail!.outcome, 'after_hold_cap' in tail!]).toEqual([false, 'applied', false]);
    expect(warns.filter((w) => w.msg === 'stt.polish skipped — delivering pure two-stage text')).toEqual([]);
    expect(infos.filter((l) => l.msg === LATE).map((l) => l.fields)).toEqual([{ segment_idx: 0, answered: false }]);
  }, 10_000);

  it('🔴 T4 R11 on the frame: a late answer is never emitted, the capped row says skipped/timeout, and the answer IS metered (reverse: stamp applied on the capped frame; reverse: emit the late answer)', async () => {
    // Row 0's provider answers at 2.4 s even though we cancelled at 2 s (ignoreAbort):
    // an answered request is cost, whatever we did with it (owner 2026-10-14 Q1).
    const LATE_TEXT = 'We looked at the numbers YESTERDAY';
    const llm = scriptedLlm((u): Reply => (u === S0 ? { full: LATE_TEXT, usage: USAGE, delayMs: 2_400, ignoreAbort: true } : { full: upperFirst(u), usage: USAGE }));
    const rig = await press(llm.streamerFor, CONTEXT);
    rig.segment(0, S0);
    await sleep(2_700);
    rig.segment(1, S1); await sleep(40);
    await rig.release(TAIL);
    const finals = rig.finals();
    expect(finals.map((f) => [f.text, f.polish, f.polish_reason ?? null])).toEqual([
      [S0, 'skipped', 'timeout'],
      [upperFirst(S1), 'applied', null],
      [upperFirst(TAIL), 'applied', null],
    ]);
    for (const f of rig.frames) expect(String(f.payload.text ?? '')).not.toContain('YESTERDAY');
    // Three answered requests ⇒ three meter calls (the late one included).
    expect(rig.usage).toHaveLength(3);
    // The row frozen at the cap is what the next row reads.
    expect(contextOf(llm.calls[1]!.user)).toBe(S0);
    expect(infos.filter((l) => l.msg === LATE).map((l) => l.fields)).toEqual([{ segment_idx: 0, answered: true }]);
    // The ROW timed out (both logs say so); the request's own answer is kept beside it.
    const row0 = timings().find((r) => r.is_segment === true && r.after_hold_cap === true);
    expect(row0?.outcome).toBe('timeout');
    expect(row0?.late_outcome).not.toBe('cancelled');
    const seg = polishFinals().filter((r) => r.stage === 'segment');
    expect(seg.map((r) => r.hold_cap_hit)).toEqual([true, false]);
  }, 10_000);

  it('🔴 re-review 3: a provider-side timeout before 2 s is skipped/timeout but NOT a cap hit (reverse: count any timeout as a cap hit)', async () => {
    const llm = scriptedLlm((u): Reply => (u === S0 ? { full: '', error: 'LLM_TIMEOUT', delayMs: 300 } : { full: upperFirst(u), usage: USAGE }));
    const rig = await press(llm.streamerFor, CONTEXT);
    rig.segment(0, S0);
    await sleep(500);
    const row0 = rig.finals()[0]!;
    expect([row0.text, row0.polish, row0.polish_reason]).toEqual([S0, 'skipped', 'timeout']);
    await rig.release(TAIL);
    expect(polishFinals().find((r) => r.stage === 'segment')).toMatchObject({ hold_cap_hit: false });
    expect(timings().find((r) => r.is_segment === true)).toMatchObject({ outcome: 'timeout' });
    expect('after_hold_cap' in timings().find((r) => r.is_segment === true)!).toBe(false);
  });

  describe('fix 4: the Smooth -> Strict retry lives inside the cap', () => {
    const BAD = 'Totally different words about lunch instead of numbers';
    const seg0Calls = (calls: { user: string }[]) => calls.filter((c) => c.user === S0 || c.user.endsWith(`\n${S0}`));

    it('🔴 too little cap left for a retry: no strict call, the row is skipped/guard_reject before the cap, and both logs agree (reverse: do not cap the request budget)', async () => {
      // Smooth answers garbage at 1.0 s ⇒ 1.0 s of the 2 s cap left, under POLISH_FALLBACK_MIN_MS (1.2 s).
      const llm = scriptedLlm((u, n): Reply => (u === S0 ? (n === 0 ? { full: BAD, usage: USAGE, delayMs: 1_000 } : { full: upperFirst(u), usage: USAGE, delayMs: 300 }) : { full: upperFirst(u), usage: USAGE }));
      const rig = await press(llm.streamerFor, CONTEXT, { strength: 'smooth' });
      rig.segment(0, S0);
      await sleep(2_300);
      await rig.release(TAIL);
      expect(seg0Calls(llm.calls)).toHaveLength(1);
      const row0 = rig.finals()[0]!;
      expect([row0.text, row0.polish, row0.polish_reason]).toEqual([S0, 'skipped', 'guard_reject']);
      expect(timings().find((r) => r.is_segment === true)).toMatchObject({ outcome: 'guard_reject', attempts: 1 });
      expect('after_hold_cap' in timings().find((r) => r.is_segment === true)!).toBe(false);
      expect(polishFinals().find((r) => r.stage === 'segment')).toMatchObject({ hold_cap_hit: false });
    }, 10_000);

    it('🔴 a retry that starts in time but runs past the cap: the row is skipped/timeout and BOTH logs say timeout', async () => {
      // Smooth refused at 0.3 s (1.7 s left ⇒ the retry is tried); strict drags 3 s.
      const llm = scriptedLlm((u, n): Reply => (u === S0 ? (n === 0 ? { full: BAD, usage: USAGE, delayMs: 300 } : { full: upperFirst(u), delayMs: 3_000 }) : { full: upperFirst(u), usage: USAGE }));
      const rig = await press(llm.streamerFor, CONTEXT, { strength: 'smooth' });
      rig.segment(0, S0);
      await sleep(2_300);
      await rig.release(TAIL);
      expect(seg0Calls(llm.calls)).toHaveLength(2);
      const row0 = rig.finals()[0]!;
      expect([row0.text, row0.polish, row0.polish_reason]).toEqual([S0, 'skipped', 'timeout']);
      expect(timings().find((r) => r.is_segment === true)).toMatchObject({ outcome: 'timeout', after_hold_cap: true });
      expect(polishFinals().find((r) => r.stage === 'segment')).toMatchObject({ hold_cap_hit: true });
    }, 10_000);
  });
});
