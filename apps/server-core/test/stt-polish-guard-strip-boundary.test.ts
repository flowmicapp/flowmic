// Card A8 — `stripClosedClassAndPunct` must use the SAME word-boundary rule
// `closedClassMultiset` already uses, not a blanket substring strip.
//
// SPEC-REF:
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md §3-A A8
//
// ── THE ACCOUNT ──────────────────────────────────────────────────────────────
// `stripClosedClassAndPunct` fed the open-class token-delta gate (§3.1 bullet
// 4). It stripped EVERY closed-class term with `s.split(term).join('')` — a
// plain substring match, no word boundary — even for the WORD_BOUNDARY_TERMS
// (en/fr/es/de/ko/ru) that `closedClassMultiset` two functions up already
// knows must be boundary-checked. "not" (a closed-class negation term) then
// matched INSIDE "nothing", stripping it to "hing"; "no" matched INSIDE
// "nowhere", stripping it to "where". This silently widens the open-class
// gate for exactly the Latin-script languages it exists to protect, because
// the caller counts whatever survives the strip as "real" content.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Reverting to `for (const term of CLOSED_CLASS_TERMS) out =
// out.split(term).join('')` (dropping the WORD_BOUNDARY_TERMS branch) turns
// this RED on both assertions below — the exact pre-fix behaviour. Seen red
// locally against the pre-fix source, then the fix was restored — see the
// WP-1 report for this run.

import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved, stripClosedClassAndPunct } from '../src/stt/stt-polish-guard';

describe('card A8 — stripClosedClassAndPunct only strips a WORD, never a mid-word substring', () => {
  it('🔴 THE NAMED REGRESSION: "nothing" survives untouched — "not" is not a word inside it', () => {
    expect(stripClosedClassAndPunct('nothing')).toBe('nothing');
  });

  it('🔴 THE SAME SHAPE, A SECOND TERM: "nowhere" survives untouched — "no" is not a word inside it', () => {
    // Before the fix: `'nowhere'.split('no').join('')` === 'where' — "no" (an
    // EN_NEGATION term) matched as a bare substring with no boundary check.
    expect(stripClosedClassAndPunct('nowhere')).toBe('nowhere');
  });

  it('a real standalone closed-class word is still stripped (the fix narrows, it does not disable)', () => {
    // "not" as an actual, boundary-delimited word is still removed — the whole
    // point of the gate. This is the positive control: the function above did
    // not just stop stripping altogether. (PUNCT_RE also strips whitespace, so
    // the surviving letters run together — that half is unchanged by this fix.)
    expect(stripClosedClassAndPunct('it is not good')).toBe('itisgood');
    expect(stripClosedClassAndPunct('is not')).toBe('is');
  });

  it('zh/ja/digit terms (no script-level word boundary) strip exactly as before — unaffected by this fix', () => {
    // 一/二/三 are each their own closed-class numeral term — CJK has no
    // script-level word boundary to check, so plain substring removal is
    // correct here and untouched by this fix.
    expect(stripClosedClassAndPunct('一二三')).toBe('');
  });
});

describe('card A8 — the same defect, seen through the public verdict', () => {
  it('a genuine open-class substitution that happens to embed a closed-class term is still judged on its own content', () => {
    // "nothing" -> "something" is a real, meaning-changing open-class edit that
    // embeds "not"/"so" as substrings with NO word boundary around them in
    // either word. Before the fix, over-stripping could erase part or all of
    // the changed fragment on one side of the diff, letting the open-class
    // gate under-count how much content actually changed. This does not assert
    // a specific ok/reject outcome (§3.1's calibration is a separate account) —
    // it asserts that `stripClosedClassAndPunct` itself, which is what feeds
    // that gate, no longer erases either word.
    expect(stripClosedClassAndPunct('nothing')).toBe('nothing');
    expect(stripClosedClassAndPunct('something')).toBe('something');
    // Sanity: the verdict function still runs end to end on this pair without
    // throwing, i.e. the fix did not just move the defect into a different
    // function.
    expect(() => checkMeaningPreserved('it is nothing special', 'it is something special')).not.toThrow();
  });
});
