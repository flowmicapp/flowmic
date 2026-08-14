// The capsule WINDOW must be tall enough to paint the capsule CARD whole.
//
// ⚠️ READ THIS BEFORE TRUSTING THE FILE: **these are not visual tests.** No
// assertion here has ever seen a pixel; a CSS change that makes the capsule ugly
// in some way other than "too tall for its window" sails straight through. What
// this file does test is the one half that IS testable: the arithmetic relation
// between the height we command the window to be (`windowHeightFor`) and the
// height the stylesheet builds the card to be (parsed, below, out of the real
// .css / .vue text — so the numbers cannot quietly drift apart).
//
// The defect it exists for (owner 2026-07-31, 0.2.31 real device (真机)): "restarting
// the APP or opening the PC side for the first time, the capsule window appears
// …the bottom is square…if you transcribe a few times the window is fine" — the capsule's TOP
// corners were round and its BOTTOM corners square, as if sliced. `capsule_resize`
// sizes the WINDOW and was being handed CAPSULE_HEIGHT, which is the CARD's height:
// in the idle form the card's content is exactly `.crow{height:56px}` = the entire
// 56px budget, so `.wrap`'s 4px gutter and `.caps`' 1px border had nowhere to go
// and the card overran its own window.
//
// MEASURED (Chromium at the real window size, 2026-07-31 — the numbers this file
// pins are derived from these, not guessed):
//   idle              560×56  → .caps bottom 9.3px BELOW the client area  → CLIPPED
//   idle_with_history 560×120 → card 94.6px (1 row) / 113.3px (5 rows)    → fits
//   speaking (long)   560×200 → card 197.5px, needs 205.5                 → CLIPPED
// A 16px radius is only ~3.5px inset from the sides 9px up its curve, which is why
// a 9px slice reads as a square bottom edge and "if you transcribe a few times it's fine": one recent row
// moves the form to idle_with_history, whose window has room for its card.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPSULE_CHROME, CAPSULE_HEIGHT, CapsuleMorph, windowHeightFor } from './capsule-morph';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CAPSULE_CSS = read('../styles/capsule.css');
const CAPSULE_VUE = read('../capsule/CapsuleApp.vue');

/** The declaration block of an EXACT selector (anchored at line start, so
 *  `.caps` never matches `.caps-ok` or `.caps .crow`). Throws rather than
 *  returning a default: a selector that has been renamed must fail loudly here,
 *  not silently assert against a fabricated number. */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)[ \\t]*${esc}[ \\t]*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for \`${selector}\` — has it been renamed?`);
  return m[1]!;
}
/** The first px length of `prop` inside `selector`'s block. */
function px(css: string, selector: string, prop: string): number {
  const body = ruleBody(css, selector);
  const decl = new RegExp(`(?:^|;)[ \\t]*${prop}[ \\t]*:([^;]+)`).exec(body);
  if (!decl) throw new Error(`\`${selector}\` declares no \`${prop}\``);
  const len = /(-?\d+(?:\.\d+)?)px/.exec(decl[1]!);
  if (!len) throw new Error(`\`${selector} { ${prop}: ${decl[1]!.trim()} }\` is not a px length`);
  return Number(len[1]);
}

// ── what the stylesheet actually builds ──
// 🔴 REQ-13-15 (2026-08-13): `.wrap` used to declare one `padding: 4px` for all
// four sides and this file read it with a single `px(…, 'padding')`. The gutter
// is now PER SIDE (the drop shadow is offset downwards, so top and bottom do not
// need the same room), which is also why the stylesheet uses longhands: a
// 3-value shorthand is precisely what a first-px-wins regex reads wrong.
const PAD_TOP = px(CAPSULE_CSS, '.wrap', 'padding-top');
const PAD_BOTTOM = px(CAPSULE_CSS, '.wrap', 'padding-bottom');
const CARD_BORDER = px(CAPSULE_CSS, '.caps', 'border'); // .caps' own 1px ring
const HEADER = px(CAPSULE_CSS, '.crow', 'height'); // the header row — the whole idle card
const STRIP_MAX = px(CAPSULE_VUE, '.recent', 'max-height'); // "delivered-in record" (转入记录) strip, bounded

describe('capsule window height vs. the card the CSS builds (owner 0.2.31 rounded corners (圆角))', () => {
  it('CAPSULE_CHROME is exactly the vertical gutter + border capsule.css declares', () => {
    // CSS cannot import a TS constant, so the agreement is asserted, not compiled.
    // Change `.wrap`'s padding or `.caps`' border and this goes red pointing at
    // CAPSULE_CHROME — which is the whole reason the number is allowed to exist.
    // ⚠️ VERTICAL only. The horizontal gutter is deliberately NOT in this
    // constant: the window width is pinned and the card yields those px instead.
    expect(CAPSULE_CHROME).toBe(PAD_TOP + PAD_BOTTOM + 2 * CARD_BORDER);
  });

  it('the IDLE window fits its card — this is the bug owner reported', () => {
    // The idle card is the header row and nothing else, so its painted height is
    // header + border; the window must additionally hold the gutter.
    const cardNeeds = HEADER + 2 * CARD_BORDER + PAD_TOP + PAD_BOTTOM;
    expect(windowHeightFor(CAPSULE_HEIGHT.idle)).toBeGreaterThanOrEqual(cardNeeds);
  });

  it('the IDLE_WITH_HISTORY window fits header + a full strip', () => {
    // The strip is bounded (it scrolls past STRIP_MAX), so this is its worst case
    // — 5 rows. It had 1.3px of DEFICIT before the fix, i.e. the same slice, just
    // small enough that owner called it "fine" (还好) rather than broken.
    const cardNeeds = HEADER + STRIP_MAX + 2 * CARD_BORDER + PAD_TOP + PAD_BOTTOM;
    expect(windowHeightFor(CAPSULE_HEIGHT.idle_with_history)).toBeGreaterThanOrEqual(cardNeeds);
  });

  it('no form is left sized to the bare card height', () => {
    // Belt to the two suspenders above: whatever CAPSULE_HEIGHT grows next, its
    // window still goes through the chrome. A form added to the table without a
    // window height is exactly how this defect got in.
    // ⚠️ Honest about its own strength: this one is TAUTOLOGICAL w.r.t. the value
    // of CAPSULE_CHROME (it stayed green in the reverse-control run at CHROME=0).
    // It guards COVERAGE — no form skipping the helper — not correctness; the two
    // tests above are the ones that see the defect.
    for (const card of Object.values(CAPSULE_HEIGHT)) {
      expect(windowHeightFor(card)).toBe(card + CAPSULE_CHROME);
    }
    // …and the resize loop's actual source of truth agrees, per morph state.
    const m = new CapsuleMorph();
    expect(m.windowHeight(0)).toBe(windowHeightFor(CAPSULE_HEIGHT.idle));
    m.setHistoryCount(1);
    expect(m.windowHeight(0)).toBe(windowHeightFor(CAPSULE_HEIGHT.idle_with_history));
    m.onSpeakingStart();
    expect(m.windowHeight(0)).toBe(windowHeightFor(CAPSULE_HEIGHT.speaking));
    m.drawerOpen = true;
    expect(m.windowHeight(0)).toBe(windowHeightFor(CAPSULE_HEIGHT.with_drawer));
  });
});
