// REQ-12-05 — the built-in offline engine's live preview (sherpa-preview.ts).
//
// The native addon is NOT involved: `decode` is injected, which is the whole
// reason the policy lives in its own module. What these tests can prove is the
// POLICY (when a decode happens, what span it covers, when a span freezes, when
// previews stand down). What they CANNOT prove is that a phone shows growing
// characters — that seam crosses a socket and a Flutter build, and it belongs to
// device-line's retest sheet (docs/strategy/2026-08-12-req1205-retest-sheet.md).
// unit tests all green prove nothing about wiring — stated here so the next reader does not mistake a
// green file for a delivered requirement.
//
// 🔴 2026-08-12 (A3-1) — THIS FILE WAS 16/16 GREEN WHILE THE FEATURE WAS BROKEN
// ON A REAL DEVICE, and two of its cases had written the defects down as the
// specification:
//   - "emits on the first chunk" asserted that tick #1 decodes a single 200 ms
//     chunk. That is defect ① in sherpa-preview.ts's header: the recognizer was
//     handed a sliver and answered with the one character the wire instrument
//     then reported as `chars:1`.
//   - "disables itself after ONE over-budget decode" asserted that a single slow
//     decode kills previews for the whole hold. On a real machine the first
//     decode after a model load IS slow (initialisation), so this is exactly how
//     the hold went silent — defect ②.
// Both are rewritten below, each with a note saying what it used to claim.
// ⇒ rule (the repo has paid for this one before, hold_out_recheck_wire_test.dart):
//   a test written from the implementation instead of from the requirement does
//   not fail to catch the defect — it PROTECTS it, and it turns the eventual fix
//   into a red build that looks like the fix is wrong.
//
// ⚠️ Every rig below passes an explicit `minTailMs`/`intervalMs`, because these
// are POLICY tests and a policy is easier to read at small numbers. That is also
// precisely why they could not see either defect: the numbers production runs at
// are the ones that break. The seam test that runs at production's settings is
// `test/req1205-interim-growth-seam.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW_BUDGET_MS,
  DEFAULT_PREVIEW_BUDGET_RTF,
  DEFAULT_PREVIEW_MAX_TAIL_MS,
  SherpaPreviewDecoder,
  joinPreviewSpans,
  previewBudgetMs,
  type PreviewDisableReason,
} from '../src/stt/engines/sherpa-preview';
import { mergeCumulativeDraft } from '../src/stt/text-merge';

const CHUNK_MS = 200;
const CHUNK_BYTES = 6_400; // 200 ms @ 16 kHz s16le — production's chunk size

/** One chunk of audible tone. Amplitude 8000 sits far above the VAD's −45 dBFS. */
function voiced(): Buffer {
  const b = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES / 2; i += 1) b.writeInt16LE(i % 2 === 0 ? 8_000 : -8_000, i * 2);
  return b;
}

/** One chunk of digital silence — −inf dBFS, always below threshold. */
function silence(): Buffer {
  return Buffer.alloc(CHUNK_BYTES);
}

/** A decoder rig with a fake clock. `decode` reports the span it was handed as
 *  `[n]` where n = number of 200 ms chunks, so every assertion below can name
 *  exactly WHICH audio was re-decoded — the one property the whole design is
 *  about. */
function rig(opts: {
  intervalMs?: number;
  /** Defaults to ONE chunk here so the cadence cases stay about cadence. The
   *  floor's own behaviour is asserted at the production default, separately. */
  minTailMs?: number;
  budgetMs?: number;
  /** INT-1. Left ABSENT by default so these cases run at production's slope;
   *  `0` reproduces the pre-INT-1 flat wall exactly (see the old-policy control). */
  budgetRtf?: number;
  budgetStrikes?: number;
  maxTailMs?: number;
  decodeCostMs?: number;
  decodeThrows?: boolean;
} = {}): {
  decoder: SherpaPreviewDecoder;
  spans: number[];
  disables: Array<{ reason: PreviewDisableReason; detail: Record<string, unknown> }>;
  feed(chunk: Buffer): string | null;
} {
  let clock = 0;
  const spans: number[] = [];
  const disables: Array<{ reason: PreviewDisableReason; detail: Record<string, unknown> }> = [];
  const decoder = new SherpaPreviewDecoder({
    decode: (pcm) => {
      spans.push(pcm.length / CHUNK_BYTES);
      clock += opts.decodeCostMs ?? 0;
      if (opts.decodeThrows) throw new Error('boom');
      return `[${pcm.length / CHUNK_BYTES}]`;
    },
    now: () => clock,
    minTailMs: opts.minTailMs ?? CHUNK_MS,
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.budgetRtf !== undefined ? { budgetRtf: opts.budgetRtf } : {}),
    ...(opts.budgetStrikes !== undefined ? { budgetStrikes: opts.budgetStrikes } : {}),
    ...(opts.maxTailMs !== undefined ? { maxTailMs: opts.maxTailMs } : {}),
    onDisabled: (reason, detail) => disables.push({ reason, detail }),
  });
  return {
    decoder,
    spans,
    disables,
    // Every chunk advances the clock by its own duration, like real audio.
    feed(chunk: Buffer): string | null {
      const out = decoder.push(chunk);
      clock += CHUNK_MS;
      return out;
    },
  };
}

describe('joinPreviewSpans — disjoint spans, nothing dropped', () => {
  it('separates two Latin words and never fuses them', () => {
    expect(joinPreviewSpans('hello', 'world')).toBe('hello world');
  });

  it('does not invent a space inside CJK', () => {
    expect(joinPreviewSpans('你好', '我是')).toBe('你好我是');
  });

  it('does not separate across punctuation', () => {
    expect(joinPreviewSpans('好了。', 'then')).toBe('好了。then');
  });

  it('is an identity on either empty side', () => {
    expect(joinPreviewSpans('', 'a')).toBe('a');
    expect(joinPreviewSpans('a', '')).toBe('a');
  });
});

describe('SherpaPreviewDecoder — the preview grows while the user holds', () => {
  // 🔴 WAS: "emits on the first chunk and again as the tail grows", with
  // `expect(r.feed(voiced())).toBe('[1]')` on tick #1 at the DEFAULT floor. That
  // first line was the defect, asserted (file header). The behaviour it should
  // have been describing — each decode covers the whole uncommitted tail — is
  // what survives, now with the floor made explicit rather than absent.
  it('decodes the whole uncommitted tail on each due tick', () => {
    const r = rig({ intervalMs: 100 });
    expect(r.feed(voiced())).toBe('[1]');
    expect(r.feed(voiced())).toBe('[2]');
    expect(r.feed(voiced())).toBe('[3]');
    // Every decode covered the whole uncommitted tail — this is the O(n²) shape
    // the spike rejected, and the next test is why it stays bounded here.
    expect(r.spans).toEqual([1, 2, 3]);
  });

  it('waits for minTailMs of audio before blocking the loop at all', () => {
    // At the PRODUCTION floor (700 ms) with production's 200 ms chunks. This is
    // the case whose absence let a single chunk reach the recognizer.
    const r = rig({ intervalMs: 100, minTailMs: 700 });
    expect(r.feed(voiced())).toBeNull(); // 200 ms in the tail
    expect(r.feed(voiced())).toBeNull(); // 400
    expect(r.feed(voiced())).toBeNull(); // 600
    expect(r.spans).toEqual([]);         // …and NOTHING was decoded meanwhile
    expect(r.feed(voiced())).toBe('[4]'); // 800 ≥ 700 — a phrase, not a sliver
    // 🔴 The skipped ticks must not have consumed the cadence: `lastDecodeAt` is
    // written only by a decode that really ran. Without that, the floor would
    // trade one defect for a slower one.
    expect(r.spans).toEqual([4]);
  });

  it('honours the interval — a chunk that arrives too soon decodes nothing', () => {
    const r = rig({ intervalMs: 700 });
    expect(r.feed(voiced())).toBe('[1]'); // clock 0, first is always due
    expect(r.feed(voiced())).toBeNull(); // clock 200
    expect(r.feed(voiced())).toBeNull(); // clock 400
    expect(r.feed(voiced())).toBeNull(); // clock 600
    expect(r.feed(voiced())).toBe('[5]'); // clock 800 ≥ 700
    expect(r.spans).toEqual([1, 5]);
  });

  it('freezes the tail at a silence boundary, so later decodes stay small', () => {
    const r = rig({ intervalMs: 100 });
    r.feed(voiced());
    r.feed(voiced());
    // 300 ms hangover ⇒ two 200 ms silent chunks close the gate.
    r.feed(silence());
    const atBoundary = r.feed(silence());
    expect(atBoundary).not.toBeNull();
    const frozen = r.decoder.committedText;
    expect(frozen).not.toBe('');

    // 🔴 THE POINT OF THE WHOLE DESIGN: the next span is decoded ALONE, not
    // together with everything said before it.
    const before = r.spans.length;
    const next = r.feed(voiced());
    expect(r.spans[before]).toBe(1);
    expect(next).toBe(`${frozen}[1]`);
  });

  it('every preview starts with the frozen prefix (the stable part never rewrites)', () => {
    const r = rig({ intervalMs: 100 });
    const seen: string[] = [];
    for (const c of [voiced(), voiced(), silence(), silence(), voiced(), voiced()]) {
      const out = r.feed(c);
      if (out !== null) {
        // Read AFTER the push: committedText is the prefix this preview was
        // built on.
        expect(out.startsWith(r.decoder.committedText)).toBe(true);
        seen.push(out);
      }
    }
    expect(seen.length).toBeGreaterThan(2);
    // ⚠️ The startsWith assertion above is VACUOUSLY TRUE while nothing has been
    // frozen ('' is a prefix of everything) — measured: with the silence freeze
    // removed it stayed green on its own. This is what makes it bite.
    expect(r.decoder.committedText).not.toBe('');
  });

  it('commits at the hard tail ceiling even when the speaker never pauses', () => {
    // 600 ms ceiling ⇒ the tail can never exceed 3 chunks.
    const r = rig({ intervalMs: 100, maxTailMs: 600 });
    for (let i = 0; i < 12; i += 1) r.feed(voiced());
    expect(Math.max(...r.spans)).toBeLessThanOrEqual(3);
  });

  it('says nothing when the text has not changed', () => {
    const r = rig({ intervalMs: 100 });
    expect(r.feed(voiced())).toBe('[1]');
    // Silence adds bytes but the fake decoder reports the span, so the text DOES
    // change here; use an unchanged-span probe instead: a zero-length chunk is
    // ignored outright.
    expect(r.decoder.push(Buffer.alloc(0))).toBeNull();
  });
});

describe('SherpaPreviewDecoder — degrading to the status quo, loudly', () => {
  // 🔴 WAS: "disables itself after ONE over-budget decode, and still delivers
  // that one". The clause after the comma is still true and still tested; the
  // clause before it was defect ② (file header) — one slow decode is what a
  // model's first inference always is, so this assertion was pinning "every
  // hold gets exactly one preview" as correct behaviour.
  it('stands down after budgetStrikes CONSECUTIVE over-budget decodes', () => {
    const r = rig({ intervalMs: 100, budgetMs: 50, decodeCostMs: 400 });
    expect(r.feed(voiced())).toBe('[1]'); // paid for; delivered anyway
    expect(r.decoder.disabled).toBe(false); // …and not yet a verdict
    expect(r.feed(voiced())).toBe('[2]');
    expect(r.decoder.disabled).toBe(true);
    expect(r.disables).toHaveLength(1);
    expect(r.disables[0]?.reason).toBe('slow_decode');
    expect(r.disables[0]?.detail).toMatchObject({ tookMs: 400, budgetMs: 50, strikes: 2 });
    // …and never blocks the loop again.
    const before = r.spans.length;
    r.feed(voiced());
    r.feed(voiced());
    expect(r.spans.length).toBe(before);
  });

  it('a slow FIRST decode followed by fast ones is a warm-up, not a verdict', () => {
    // The production shape: one 400 ms initialisation decode, then 10 ms each.
    let cost = 400;
    let clock = 0;
    const spans: number[] = [];
    const disables: PreviewDisableReason[] = [];
    const decoder = new SherpaPreviewDecoder({
      decode: (pcm) => { spans.push(pcm.length / CHUNK_BYTES); clock += cost; cost = 10; return `[${spans.length}]`; },
      now: () => clock,
      intervalMs: 100,
      minTailMs: CHUNK_MS,
      budgetMs: 50,
      onDisabled: (reason) => disables.push(reason),
    });
    for (let i = 0; i < 5; i += 1) { decoder.push(voiced()); clock += CHUNK_MS; }
    expect(disables).toEqual([]);
    expect(spans.length).toBe(5); // every tick still decoded
    expect(decoder.stats).toMatchObject({ overBudget: 1, maxDecodeMs: 400, disabled: null });
  });

  it('a throwing decode disables previews instead of escaping into the engine', () => {
    const r = rig({ intervalMs: 100, decodeThrows: true });
    expect(() => r.feed(voiced())).not.toThrow();
    expect(r.decoder.disabled).toBe(true);
    expect(r.disables[0]?.reason).toBe('decode_failed');
  });

  it('reports the reason exactly once', () => {
    const r = rig({ intervalMs: 100, decodeThrows: true });
    r.feed(voiced());
    r.feed(voiced());
    r.feed(voiced());
    expect(r.disables).toHaveLength(1);
  });

  it('reset() clears the frozen text, the disable latch, the strikes and the stats', () => {
    const r = rig({ intervalMs: 100, budgetMs: 50, decodeCostMs: 400 });
    r.feed(voiced());
    r.feed(voiced());
    expect(r.decoder.disabled).toBe(true);
    r.decoder.reset();
    expect(r.decoder.disabled).toBe(false);
    expect(r.decoder.committedText).toBe('');
    // 🔴 The strike run resets too. A leftover strike would make the NEXT
    // utterance stand down on its first slow decode — i.e. the fixed defect
    // would come back one utterance later, which is worse than never fixing it
    // because it looks intermittent.
    expect(r.decoder.stats).toMatchObject({ decodes: 0, emitted: 0, overBudget: 0, maxDecodeMs: 0, disabled: null });
    r.feed(voiced());
    expect(r.decoder.disabled).toBe(false);
  });
});

describe('🔴 INT-1 — the budget judges the MACHINE, not the length of the sentence', () => {
  // ── THE REAL-HARDWARE READINGS THIS BLOCK EXISTS TO HONOUR ────────────────
  // scratch/r7-req1205-round2-2026-08-12.md §2-1, dev-pc-a (the owner's
  // own development machine — NOT the weak CPU the budget was built to catch):
  //     132 ms @  5.04 s   ·   301 ms @ 11.04 s   ·   320 ms @ 17.04 s
  // The third one hit strike 2 and printed "live preview disabled". All three
  // divide out to RTF ≈ 0.027, i.e. the machine was behaving identically in all
  // three and only the LENGTH differed. That is the whole defect.
  //
  // ⚠️ HONEST UNIT NOTE for the 17 s row: the wall is applied to the DECODED
  // TAIL, and the tail is capped at DEFAULT_PREVIEW_MAX_TAIL_MS (12 s) and
  // freezes at every silence — so a 17 s utterance's decode covers AT MOST 12 s.
  // Asserted below against 12 s, not 17, because pairing that 320 ms with 17 s
  // would be quoting a ratio no decode ever had.

  it('🔴 none of the three real readings trips the new wall', () => {
    const wall = (tailMs: number): number =>
      previewBudgetMs(tailMs, DEFAULT_PREVIEW_BUDGET_MS, DEFAULT_PREVIEW_BUDGET_RTF);
    expect(132).toBeLessThanOrEqual(wall(5_040));
    expect(301).toBeLessThanOrEqual(wall(11_040));
    expect(320).toBeLessThanOrEqual(wall(DEFAULT_PREVIEW_MAX_TAIL_MS)); // the 17 s row
  });

  it('🔴 …and a genuinely pathological decode still trips it', () => {
    // 900 ms to decode 5 s of audio is RTF 0.18 — nearly seven times the
    // measured machine, and 4.3 s of blocked event loop on a 24 s tail. This is
    // the case the budget exists for and it must survive the fix.
    const wall = previewBudgetMs(5_000, DEFAULT_PREVIEW_BUDGET_MS, DEFAULT_PREVIEW_BUDGET_RTF);
    expect(900).toBeGreaterThan(wall);
  });

  it('the floor still governs everything shorter than a 5 s tail — unchanged', () => {
    // 5000 × 0.06 = 300 = the floor, so this change CANNOT have made any
    // short-tail decision more permissive than the shipped one.
    for (const tail of [0, 200, 700, 2_000, 4_999]) {
      expect(previewBudgetMs(tail, DEFAULT_PREVIEW_BUDGET_MS, DEFAULT_PREVIEW_BUDGET_RTF))
        .toBe(DEFAULT_PREVIEW_BUDGET_MS);
    }
  });

  it('🔴 the worst single block this policy can authorise stays bounded', () => {
    // The ceiling is DERIVED (tail ≤ maxTail ⇒ budget ≤ maxTail × rtf), not
    // declared, so this test is the mechanism that keeps it honest: raising
    // either constant has to come past here and be argued.
    const ceiling = previewBudgetMs(DEFAULT_PREVIEW_MAX_TAIL_MS, DEFAULT_PREVIEW_BUDGET_MS, DEFAULT_PREVIEW_BUDGET_RTF);
    expect(ceiling).toBe(720);
    expect(ceiling).toBeLessThanOrEqual(1_000);
  });

  it('🔴 a long utterance decoded at 301 ms keeps its preview alive', () => {
    // The device's 11 s row, driven through the real decoder at production's
    // budget. `minTailMs` 11 s + `intervalMs` 1 puts every decode at an 11-12 s
    // tail, which is exactly where the shipped wall killed previews.
    const r = rig({ intervalMs: 1, minTailMs: 11_000, decodeCostMs: 301 });
    for (let i = 0; i < 60; i += 1) r.feed(voiced());
    expect(r.spans.length).toBeGreaterThan(0);
    expect(Math.max(...r.spans)).toBeGreaterThanOrEqual(55); // ≥ 11 s of tail
    expect(r.disables).toEqual([]);
    expect(r.decoder.disabled).toBe(false);
    expect(r.decoder.stats.overBudget).toBe(0);
  });

  it('🔴 OLD-POLICY CONTROL: the same utterance under the flat wall goes silent', () => {
    // `budgetRtf: 0` IS the shipped pre-INT-1 policy (budget = the floor, for
    // every tail). Same audio, same decode cost, same everything else.
    // 🔴 This is not decoration: without it, the test above is compatible with
    // "the budget stopped working at all", which is a much worse fix.
    const r = rig({ intervalMs: 1, minTailMs: 11_000, decodeCostMs: 301, budgetRtf: 0 });
    for (let i = 0; i < 60; i += 1) r.feed(voiced());
    expect(r.decoder.disabled).toBe(true);
    expect(r.disables[0]?.reason).toBe('slow_decode');
    // …and the WARN now says WHY it is a verdict, in numbers an operator can
    // divide: 301 / 11000 = RTF 0.027 against a floor of 300.
    expect(r.disables[0]?.detail).toMatchObject({ tookMs: 301, budgetMs: 300, strikes: 2 });
    expect((r.disables[0]?.detail as { tailMs: number }).tailMs).toBeGreaterThanOrEqual(11_000);
  });

  it('🔴 a truly slow machine still stands down, and at the same two decodes as before', () => {
    // RTF ≈ 0.45 (900 ms per 2 s of tail). Production floor, production slope.
    const r = rig({ intervalMs: 1, minTailMs: 5_000, decodeCostMs: 900 });
    for (let i = 0; i < 40; i += 1) r.feed(voiced());
    expect(r.decoder.disabled).toBe(true);
    expect(r.disables[0]?.reason).toBe('slow_decode');
    expect(r.disables[0]?.detail).toMatchObject({ tookMs: 900, strikes: 2 });
    // Two decodes paid for, then the loop is left alone — the same contract the
    // strike counter always had.
    expect(r.spans.length).toBe(2);
  });

  it('maxDecodeTailMs pairs with maxDecodeMs so the log line divides into an RTF', () => {
    const r = rig({ intervalMs: 1, minTailMs: 11_000, decodeCostMs: 301 });
    for (let i = 0; i < 56; i += 1) r.feed(voiced());
    const { maxDecodeMs, maxDecodeTailMs } = r.decoder.stats;
    expect(maxDecodeMs).toBe(301);
    expect(maxDecodeTailMs).toBeGreaterThanOrEqual(11_000);
    // 🔴 The point of the field: this division is what round 2 had to ARGUE for
    // (its only pairing was maxDecodeMs against the utterance's audio_ms, which
    // is not what any decode was handed).
    expect(maxDecodeMs / maxDecodeTailMs).toBeLessThan(0.06);
  });

  it('reset() clears the new stat too', () => {
    const r = rig({ intervalMs: 1, minTailMs: 200, decodeCostMs: 10 });
    r.feed(voiced());
    expect(r.decoder.stats.maxDecodeTailMs).toBeGreaterThan(0);
    r.decoder.reset();
    expect(r.decoder.stats.maxDecodeTailMs).toBe(0);
  });
});

describe('REQ-12-05 — the preview survives the orchestrator seam it feeds', () => {
  // 🔴 in-place correction (INT-2, 2026-08-12). THIS BLOCK USED TO DRIVE `mergeOnlineDraft`,
  // and its comment read: "so the merge's revision branch, not its append
  // branch, is the one that must fire". That sentence was FALSE ON THE DAY IT
  // WAS WRITTEN, and it is the exact shape reverse-control is supposed to catch:
  // both cases below are pure EXTENSIONS, so `next.startsWith(draft)` answered
  // first and the revision branch never ran in either of them. The block was
  // green, and it was green for a reason unrelated to what it claimed.
  //
  // On the real device the revision branch did NOT fire (short CJK clauses: the
  // shared prefix is 6 < REVISION_MIN_PREFIX), the APPEND branch did, and one
  // 5 s sentence reached the phone twice — see text-merge.ts
  // `mergeCumulativeDraft` for the measurement and the whole argument.
  //
  // ⇒ The seam these cases describe now goes through `mergeCumulativeDraft`,
  // selected by this engine's `interimShape:'cumulative'` declaration
  // (`orchestrator-core.ts` `foldDraft`). The two original assertions are kept
  // VERBATIM below — they are still true, and now for the stated reason.
  // ⚠️ Unit-level cases here; the seam is driven end-to-end in
  // `test/req1205-interim-growth-seam.test.ts`, which is where a preview that
  // stopped being cumulative would actually be caught.
  it('an extending preview folds to itself, never to a doubled sentence', () => {
    let draft = '';
    for (const p of ['你好', '你好我是', '你好我是小明']) draft = mergeCumulativeDraft(draft, p);
    expect(draft).toBe('你好我是小明');
  });

  it('a revised tail replaces rather than piles up', () => {
    let draft = '';
    for (const p of [
      'the tribal chieftain called for',
      'the tribal chieftain called for the boy',
    ]) draft = mergeCumulativeDraft(draft, p);
    expect(draft).toBe('the tribal chieftain called for the boy');
  });

  it('🔴 a MID-STRING revision — the case the old wiring got wrong', () => {
    // Run C's shape, at the unit the block claims to describe. Under
    // `mergeOnlineDraft` this produced "跟你说个事啊。跟你说个事啊，明天下午。".
    let draft = '';
    for (const p of ['跟你说个事啊。', '跟你说个事啊，明天下午。']) draft = mergeCumulativeDraft(draft, p);
    expect(draft).toBe('跟你说个事啊，明天下午。');
    expect(draft.split('跟你说个事啊')).toHaveLength(2);
  });
});
