// GUARD-1 — the dense-short-source allowance in output-guard-volume.ts, and the
// narrowing clauses that keep it from becoming a hole.
//
// 🔴 WHY THIS FILE EXISTS. The allowance (`volumeBudget`, translate arm) grants a
// dense short CJK source an 18× budget so 「画蛇添足」→ "To ruin something by
// adding what is unnecessary." (12–16×) is not false-rejected. Three narrowing
// clauses stop that allowance from swallowing the failure it is carved around
// (the model answering instead of translating). Measured 2026-08-09 on
// dev-pc-a against the real bundled guard, NONE of those clauses had any
// corpus case that isolated it: removing the CJK-target clause, or the han-
// density clause, left `run-eval.mjs --mode=guard` at 73/193 with 0 breaches
// (they were unsupervised — card GUARD-1). This file supervises them directly:
// each test constructs the one input for which a single clause decides the
// verdict, so deleting that clause flips the assertion and reddens this suite.
//
// 🔴 IT ALSO PINS THE CORRECTED CLAIM (GUARD-1 part A). eval-guard.mjs used to
// say the `translate/short_idiom` count floor was "the reverse control" for the
// allowance's MAGNITUDE — "if the allowance is ever widened past the point where
// it swallows those replies, this number drops." Measured, that is false:
// amplifying DENSE_SHORT_EXPANSION ×1e9 leaves short_idiom at 10/13 UNMOVED,
// because the idiom-replies are multi-sentence and the sentence-count clause
// excludes them from the allowance path entirely — they are caught by `base`
// (6×) regardless of the magnitude. What the floor actually supervises is the
// SENTENCE-COUNT clause (neutralising it drops short_idiom 10→9). The asymmetry
// block below is that finding, expressed as behaviour of the production guard.

import { describe, expect, it } from 'vitest';
import { guardComposeOutput } from '../src/compose/output-guard';

const ruleOf = (v: ReturnType<typeof guardComposeOutput>): string | null => (v.ok ? null : v.rule);

// A four-Han-character idiom: inLen = 4, so base = max(24, 4×6) = 24 characters and
// the dense-short allowance = max(24, 4×18) = 72 characters. Every case below is
// read against those two numbers.
const IDIOM = '画蛇添足';
const tr = (source: string, output: string, target_lang = 'en', source_lang = 'zh-CN') =>
  guardComposeOutput({ task: 'translate', source, output, source_lang, target_lang });

describe('GUARD-1 A — what actually protects the dense-short allowance (the asymmetry)', () => {
  // The real protector is the SENTENCE-COUNT clause, not the DENSE_SHORT_EXPANSION
  // magnitude. These two outputs carry the same content at near-identical length
  // (63 vs 62 code points, both ~15.7× — inside the 72-char allowance); the ONLY
  // difference is that the second is split into two sentences.

  it('accepts a single-sentence dense-short translation inside the 18× allowance', () => {
    // One utterance → the allowance is granted → 63 ≤ 72 → delivered. This is the
    // legitimate idiom rendering the allowance exists for.
    expect(tr(IDIOM, 'It means ruining a thing by adding something quite unnecessary.').ok).toBe(true);
  });

  it('rejects the SAME content split into two sentences (sentence-count clause is load-bearing)', () => {
    // Two utterances → the allowance is withheld → budget falls back to base (24)
    // → 62 > 24 → volume_runaway. Delete the sentence-count clause in
    // `volumeBudget` and this flips to ok — that is the mutation this test exists
    // to catch. Measured 2026-08-09: neutralising that clause also drops the
    // production `translate/short_idiom` floor 10→9.
    expect(ruleOf(tr(IDIOM, 'It means ruining a thing. It adds something quite unnecessary.')))
      .toBe('volume_runaway');
  });

  it('rejects a two-sentence reply whose ratio is WELL INSIDE the 18× band (magnitude is not the protector)', () => {
    // 29 code points = 7.25×, comfortably under the 72-char allowance — yet still
    // rejected, because a multi-sentence output never enters the allowance path at
    // all. This is why amplifying DENSE_SHORT_EXPANSION ×1e9 does NOT move
    // short_idiom: its catches never depended on the magnitude. The floor's claim
    // to supervise the allowance width was false (GUARD-1); this pins the truth.
    expect(ruleOf(tr(IDIOM, 'All done here. Anything else?'))).toBe('volume_runaway');
  });
});

describe('GUARD-1 B — the two narrowing clauses that had zero supervising corpus', () => {
  // Each test isolates one clause: the input is constructed so that clause, and
  // only that clause, forces the budget back to `base`. Removing it grants the
  // allowance and the case is accepted. Measured 2026-08-09 on dev-pc-a:
  // each removal flips exactly its own case and leaves the other two rejected.

  it('CJK-target clause is load-bearing: a dense idiom → Japanese, one sentence, is held to base', () => {
    // Source is 4/4 Han (passes the han-density clause) and the output is one
    // Japanese sentence of 28 code points = 7× (inside 72). The ONLY thing forcing
    // base(24) is the clause `target === 'japanese' → base`; 28 > 24 → rejected.
    // Delete that clause and the han-density clause below no longer covers it
    // (the source IS dense), so the allowance grants 72 and this flips to ok. That
    // is the previously-unsupervised regression this asserts against.
    expect(ruleOf(tr(IDIOM, 'それは余計なことをして物事を台無しにするという意味です。', 'ja')))
      .toBe('volume_runaway');
  });

  it('the same idiom → Japanese, rendered compactly, is still accepted (the clause does not over-reject)', () => {
    // The paired accept: a CJK target legitimately renders an idiom compactly, so the
    // stricter base budget it is held to is the right one. 蛇足 is the standard
    // Japanese equivalent.
    expect(tr(IDIOM, '蛇足。', 'ja').ok).toBe(true);
  });

  it('han-density clause is load-bearing: a NON-dense short source → English is held to base', () => {
    // Source 「OK了」 is 1/3 CJK (< HAN_SOURCE_FRACTION), target is English (so the
    // CJK-target clause does NOT fire first). The ONLY thing forcing base is the
    // han-density clause; the single-sentence 51-code-point output is 51 > 24 →
    // rejected. Delete that clause and the allowance grants 54 (3×18), flipping
    // this to ok — the regression this asserts against.
    expect(ruleOf(tr('OK了', 'Sure, I have taken care of all of that for you now.')))
      .toBe('volume_runaway');
  });

  it('the same non-dense source rendered compactly is still accepted', () => {
    expect(tr('OK了', 'Okay, done.').ok).toBe(true);
  });
});
