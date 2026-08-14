// REQ-13-15 — the capsule's drop shadow must reach zero alpha INSIDE the window.
//
// owner 2026-08-13: "outside the capsule window's main display area there's a
// semi-transparent gradient, and on WINDOWS you can clearly see a cut edge"
// (胶囊窗口主显示区外会有半透明惭变，在WINDOWS下可以看到明显的切边). The gradient is `.caps`' box-shadow. On a transparent window there is
// nothing outside the window rect to draw on, so a shadow that is still visible
// when it reaches that rect does not fade — it STOPS, and a straight line where
// alpha jumps to zero is exactly what "cut edge" (切边) describes.
//
// ⚠️ READ THIS BEFORE TRUSTING THE FILE: **this is not a visual test.** No
// assertion here has ever seen a pixel, and it cannot tell you the capsule looks
// good — only that the declared geometry leaves room for the declared shadow.
// The look is a device-line leg (Windows first, then the Mac once transparency
// works there at all). What this file removes is the ability for the two numbers
// to drift apart silently, which is how they got here: the shadow was authored
// in tokens.css and the gutter in capsule.css, and nothing related them.
//
// ── THE ARITHMETIC, AND ITS ONE ASSUMPTION ───────────────────────────────────
// For `box-shadow: <dx> <dy> <blur> [<spread>] <color>`, CSS specifies that the
// blur produces a transition roughly `blur` wide CENTRED on the shadow's edge —
// so the shadow's visible extent past the source box is `spread + blur/2`,
// shifted by the offset. Per side:
//     left   = spread + blur/2 − dx        right  = spread + blur/2 + dx
//     top    = spread + blur/2 − dy        bottom = spread + blur/2 + dy
// The assumption is that "blur/2" half-width, which is what the spec describes
// and what every engine implements as a Gaussian approximation. It is an
// APPROXIMATION: the true Gaussian tail is asymptotic and never exactly zero, so
// this measures "where the shadow stops being visible", not "where alpha is
// mathematically 0". That is why the assertions demand strict headroom rather
// than mere equality — an exact fit would put the last visible sliver on the
// window edge, which is the defect again with a smaller amplitude.
//
// The numbers this pins (2026-08-13, both themes):
//   shadow 0 5px 12px  → left/right 6, top 1, bottom 11
//   shadow 0 1px 4px   → left/right 2, top 1, bottom 3
//   gutter             → left/right 8, top 4, bottom 14
// Before the fix the shadow was 0 12px 32px + 0 2px 8px against a 4px gutter:
// left/right needed 16 and bottom needed 28. Three sides clipped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPSULE_HEIGHT, CAPSULE_WIDTH, windowHeightFor } from './capsule-morph';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CAPSULE_CSS = read('../styles/capsule.css');
const TOKENS_CSS = read('../styles/tokens.css');
const TAURI_CONF = JSON.parse(read('../../src-tauri/tauri.conf.json')) as {
  app: { windows: Array<{ label: string; width: number; height: number }> };
};

/** A px-valued declaration inside an EXACT selector's block. Throws rather than
 *  defaulting: a renamed selector must fail loudly, not silently assert against
 *  a fabricated number (same contract as capsule-chrome.test.ts's helper). */
function px(css: string, selector: string, prop: string): number {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`(?:^|\\n)[ \\t]*${esc}[ \\t]*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no rule for \`${selector}\` — has it been renamed?`);
  const decl = new RegExp(`(?:^|;)[ \\t]*${prop}[ \\t]*:([^;]+)`).exec(block[1]!);
  if (!decl) throw new Error(`\`${selector}\` declares no \`${prop}\``);
  const len = /(-?\d+(?:\.\d+)?)px/.exec(decl[1]!);
  if (!len) throw new Error(`\`${selector} { ${prop}: ${decl[1]!.trim()} }\` is not a px length`);
  return Number(len[1]);
}

/** Every `--caps-shadow` declaration in tokens.css, in source order (light theme
 *  first, then whatever the dark block redefines). Both are asserted: the window
 *  rect does not care which palette is up. */
function capsShadowDeclarations(): string[] {
  const found = [...TOKENS_CSS.matchAll(/--caps-shadow\s*:([^;]+);/g)].map((m) => m[1]!.trim());
  if (found.length === 0) throw new Error('tokens.css declares no `--caps-shadow`');
  return found;
}

interface Extent { left: number; right: number; top: number; bottom: number }

/** Split a multi-layer shadow value on top-level commas (the ones inside
 *  `rgba(…)` are not separators) and measure each layer's reach per side. */
function layerExtents(value: string): Extent[] {
  const layers: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      layers.push(cur);
      cur = '';
    } else cur += ch;
  }
  layers.push(cur);

  return layers.map((layer) => {
    const lengths = [...layer.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    // dx dy [blur] [spread] — a bare `0 0` layer is legal CSS and reaches nowhere.
    if (lengths.length < 2) throw new Error(`shadow layer has no offsets: \`${layer.trim()}\``);
    const [dx = 0, dy = 0, blur = 0, spread = 0] = lengths;
    const reach = spread + blur / 2;
    return { left: reach - dx, right: reach + dx, top: reach - dy, bottom: reach + dy };
  });
}

const GUTTER = {
  left: px(CAPSULE_CSS, '.wrap', 'padding-left'),
  right: px(CAPSULE_CSS, '.wrap', 'padding-right'),
  top: px(CAPSULE_CSS, '.wrap', 'padding-top'),
  bottom: px(CAPSULE_CSS, '.wrap', 'padding-bottom'),
};
const SIDES = ['left', 'right', 'top', 'bottom'] as const;

describe('REQ-13-15: the capsule shadow fades out inside the window rect', () => {
  it.each(capsShadowDeclarations().map((v, i) => [i === 0 ? 'light' : `theme #${i}`, v]))(
    '%s theme — every shadow layer stops short of the window edge on every side',
    (_theme, value) => {
      const extents = layerExtents(value as string);
      expect(extents.length).toBeGreaterThan(0);
      for (const [i, e] of extents.entries()) {
        for (const side of SIDES) {
          // STRICTLY less, not <=: see the header on why an exact fit is the
          // same defect with a smaller amplitude.
          expect(
            e[side],
            `layer ${i} reaches ${e[side]}px ${side}, gutter is ${GUTTER[side]}px — ` +
              'the gradient would be cut off by the window rect (REQ-13-15)',
          ).toBeLessThan(GUTTER[side]);
        }
      }
    },
  );

  it('no capsule card paints a shadow that bypasses the token', () => {
    // The reason this exists: `.caps-ok` / `.caps-fail` used to carry their own
    // copy of the old `0 12px 32px`, so shrinking the token alone would have
    // fixed the idle capsule and left the success and failure flashes clipped —
    // the two moments the user is most likely to be looking straight at it.
    // A literal shadow on a card-level selector is therefore a defect by
    // construction, no matter what its numbers happen to be.
    for (const selector of ['.caps', '.caps-ok', '.caps-fail']) {
      expect(px.bind(null, CAPSULE_CSS, selector, 'box-shadow')).toThrow(/not a px length/);
    }
  });

  it('the capsule window declared in tauri.conf is the size the morph table asks for', () => {
    // The initial window is sized by tauri.conf, every later size by
    // `capsule_resize`. Nothing related the two, so growing the chrome could
    // have left the very first capsule a user ever sees clipped while every
    // subsequent morph was correct — the 0.2.31 defect's shape, restricted to
    // first paint, which is exactly where owner reported seeing it that time.
    const capsule = TAURI_CONF.app.windows.find((w) => w.label === 'capsule');
    expect(capsule, 'tauri.conf.json declares no window labelled `capsule`').toBeTruthy();
    expect(capsule!.width).toBe(CAPSULE_WIDTH);
    expect(capsule!.height).toBe(windowHeightFor(CAPSULE_HEIGHT.idle));
  });

  it('the card still gets a usable width after the horizontal gutter', () => {
    // The window width is pinned (07 §1, positioning, drag clamp), so the card
    // is what pays for a wider gutter. Stated as a floor rather than an equality
    // so it documents the trade instead of freezing today's number: the header
    // row's layout (name + channel chip + target chip) was tuned around ~550.
    const cardWidth = CAPSULE_WIDTH - GUTTER.left - GUTTER.right;
    expect(cardWidth).toBeGreaterThanOrEqual(540);
    expect(cardWidth).toBeLessThanOrEqual(CAPSULE_WIDTH);
  });
});
