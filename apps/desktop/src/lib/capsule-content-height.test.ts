// RV-81 (窗口B4, 2026-08-01) — the test class this repo did not have until now:
// one that ties `CAPSULE_HEIGHT` to what the card ACTUALLY RENDERS, not to
// another number that merely agrees with it by construction.
//
// `capsule-chrome.test.ts` already says out loud what it cannot prove: its
// per-form loop is "TAUTOLOGICAL w.r.t. CAPSULE_CHROME... guards COVERAGE, not
// correctness" (see that file). It asserts window == table + chrome for every
// form — which was exactly true before AND after RV-81's fix, because nobody
// had ever changed how `windowHeightFor` adds chrome. What it never asked is
// whether the TABLE value itself describes real content. That gap is how
// `just_injected`/`inject_failed` sat at 140 (real content: 56, fixed) and
// `with_drawer` sat at 560 (real content: ~231–286, worst case) for as long as
// they did — a full unit-test suite, green the whole time.
//
// ⚠️ HONEST ABOUT WHAT THIS FILE IS AND IS NOT:
//   - `just_injected` / `inject_failed`: EXACT. Their card is one CSS-forced
//     `height:56px` row (`.caps-ok .crow` / `.caps-fail .crow`), not a
//     content-flow height — so parsing that declaration out of the real
//     capsule.css text and asserting equality is a genuine, non-tautological
//     check with zero modeling error. If a future edit changes that row's
//     height without updating CAPSULE_HEIGHT, this goes red pointing here.
//   - `with_drawer`: a MODEL, not a live measurement. `.diag`'s height is a
//     sum of parsed padding/margin/font-size numbers × an assumed line-height
//     (`body{line-height:1.55}` from tokens.css) — arithmetic, not a real
//     browser laying out real boxes. It was cross-checked ONCE against a real
//     Chromium render on 2026-08-01 (Playwright, verbatim CSS + markup,
//     getBoundingClientRect): the model said ~284.9px for the 6-row worst
//     case, the real browser said 286.18px — 1.3px apart, folded into
//     FORMULA_VS_REAL_SLACK below. A genuine regression test would render the
//     real component in a real browser on every run; this repo's vitest
//     environment is `node` (see vitest.config.ts — no jsdom/happy-dom, no
//     @vue/test-utils, nothing that lays out real CSS) and has never had that
//     capability. Adding it would mean a NEW project dependency (Playwright or
//     equivalent, a real Chromium binary, and a harness to drive `state` into
//     each form) — a real cost, reported rather than added unilaterally
//     (see the window-B4 report for the estimate). This file is the cheap
//     87%-of-the-value version: it cannot catch "the real renderer's font
//     metrics quietly shifted", but it WILL catch "someone changed `.diag`'s
//     padding, or added a 7th possible row, and forgot CAPSULE_HEIGHT".
//
// ── reverse-control (self-proof this file can fail) ──
// Manually setting CAPSULE_HEIGHT back to { just_injected: 140, inject_failed:
// 140, with_drawer: 560 } and running this file goes RED on all three new
// assertions below (140 !== 56 twice; 560 is above WITH_DRAWER_UPPER_BOUND) —
// run on 2026-08-01, restored immediately after, residual `grep -n "140\|560"
// apps/desktop/src/lib/capsule-morph.ts` = 0 hits for those two numbers as
// CAPSULE_HEIGHT entries.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPSULE_HEIGHT } from './capsule-morph';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CAPSULE_CSS = read('../styles/capsule.css');
const TOKENS_CSS = read('../styles/tokens.css');

/** The declaration block of an EXACT selector (anchored at line start, so
 *  `.diag` never matches `.diag h4` or `.diag .drow`). Same technique as
 *  capsule-chrome.test.ts's `ruleBody` — duplicated rather than imported: it is
 *  ~6 lines and importing across two *.test.ts files buys nothing a copy
 *  doesn't (Token discipline: reuse before rewrite (Token 纪律 搬运优先于重写), applied to test helpers too). */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)[ \\t]*${esc}[ \\t]*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for \`${selector}\` — has it been renamed?`);
  return m[1]!;
}
function declaration(css: string, selector: string, prop: string): string {
  const body = ruleBody(css, selector);
  const m = new RegExp(`(?:^|;)[ \\t]*${prop}[ \\t]*:([^;]+)`).exec(body);
  if (!m) throw new Error(`\`${selector}\` declares no \`${prop}\``);
  return m[1]!.trim();
}
function px(css: string, selector: string, prop: string): number {
  const decl = declaration(css, selector, prop);
  const m = /(-?\d+(?:\.\d+)?)px/.exec(decl);
  if (!m) throw new Error(`\`${selector} { ${prop}: ${decl} }\` is not a px length`);
  return Number(m[1]);
}
/** A bare (unitless) number declaration, e.g. `line-height: 1.55`. */
function bareNumber(css: string, selector: string, prop: string): number {
  const decl = declaration(css, selector, prop);
  const m = /(-?\d+(?:\.\d+)?)/.exec(decl);
  if (!m) throw new Error(`\`${selector} { ${prop}: ${decl} }\` is not a bare number`);
  return Number(m[1]);
}
/** CSS 1-4 value shorthand (margin/padding) → {top,right,bottom,left}, by the
 *  standard CSS expansion rule. Throws on anything else rather than guessing. */
function box(css: string, selector: string, prop: string): { top: number; right: number; bottom: number; left: number } {
  const decl = declaration(css, selector, prop);
  const parts = decl.trim().split(/\s+/).map((v) => {
    if (v === '0') return 0; // bare zero is valid CSS with no unit at all
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
    if (!m) throw new Error(`\`${selector} { ${prop}: ${decl} }\` has a non-px component \`${v}\``);
    return Number(m[1]);
  });
  if (parts.length === 1) return { top: parts[0]!, right: parts[0]!, bottom: parts[0]!, left: parts[0]! };
  if (parts.length === 2) return { top: parts[0]!, right: parts[1]!, bottom: parts[0]!, left: parts[1]! };
  if (parts.length === 3) return { top: parts[0]!, right: parts[1]!, bottom: parts[2]!, left: parts[1]! };
  if (parts.length === 4) return { top: parts[0]!, right: parts[1]!, bottom: parts[2]!, left: parts[3]! };
  throw new Error(`\`${selector} { ${prop}: ${decl} }\` has ${parts.length} components, expected 1-4`);
}

describe('CAPSULE_HEIGHT vs. what the card actually renders (RV-81, owner 路A)', () => {
  it('just_injected: table value equals the REAL `.caps-ok .crow` CSS height (exact, not a model)', () => {
    const real = px(CAPSULE_CSS, '.caps-ok .crow', 'height');
    expect(CAPSULE_HEIGHT.just_injected).toBe(real);
  });

  it('inject_failed: table value equals the REAL `.caps-fail .crow` CSS height (exact, not a model)', () => {
    const real = px(CAPSULE_CSS, '.caps-fail .crow', 'height');
    expect(CAPSULE_HEIGHT.inject_failed).toBe(real);
  });

  it('with_drawer: table value brackets the modeled 6-row worst case (see file header for the model\'s honest limits)', () => {
    // Same base header the with_drawer form actually renders (`.caps .crow`,
    // NOT `.caps-ok .crow`/`.caps-fail .crow` — those are separate overridden
    // declarations that happen to share today's value, not the same rule).
    const header = px(CAPSULE_CSS, '.crow', 'height');
    const lineHeight = bareNumber(TOKENS_CSS, 'body', 'line-height');

    const diagMargin = box(CAPSULE_CSS, '.diag', 'margin');
    const diagPad = box(CAPSULE_CSS, '.diag', 'padding');
    const diagFont = px(CAPSULE_CSS, '.diag', 'font-size');
    const h4Font = px(CAPSULE_CSS, '.diag h4', 'font-size');
    const h4MarginBottom = px(CAPSULE_CSS, '.diag h4', 'margin-bottom');
    const drowPad = box(CAPSULE_CSS, '.diag .drow', 'padding');

    const ROWS_WORST_CASE = 6; // 4 always-shown + endpointLine + lastLoudReason (both v-if)
    const rowContent = diagFont * lineHeight; // one line of the row's own inherited text
    const h4Content = h4Font * lineHeight;
    const diagInner = h4Content + h4MarginBottom + ROWS_WORST_CASE * (drowPad.top + drowPad.bottom + rowContent);
    const diagTotal = diagMargin.top + diagPad.top + diagInner + diagPad.bottom + diagMargin.bottom;
    const modeled = header + diagTotal;

    // 1.3px: the gap this model measured against a real Chromium render on
    // 2026-08-01 (model 284.85 vs measured 286.18) — see file header. Folded
    // in as a fixed, documented slack rather than silently trusting the model.
    const FORMULA_VS_REAL_SLACK = 2;
    const lowerBound = Math.ceil(modeled) + FORMULA_VS_REAL_SLACK;
    // 20px: intentional rounding headroom (same spirit as idle_with_history /
    // speaking's existing few-px margins) — NOT an invitation to drift back
    // toward "hundreds of px of pure margin", which is the exact defect this
    // round fixes. A value outside this band is either under-sized (risks the
    // RV-79 shape: a real clip) or has quietly regressed back toward RV-81's.
    const upperBound = lowerBound + 20;

    expect(CAPSULE_HEIGHT.with_drawer).toBeGreaterThanOrEqual(lowerBound);
    expect(CAPSULE_HEIGHT.with_drawer).toBeLessThanOrEqual(upperBound);
  });
});
