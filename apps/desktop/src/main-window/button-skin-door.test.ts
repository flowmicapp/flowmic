// The button-skin door (0.3.33).
//
// ── WHAT THIS EXISTS TO CATCH ───────────────────────────────────────────────
//
// A `<button class="btn sm">` looks finished in a diff and renders as bare grey
// text. `tokens.css` gives `.btn` layout only (flex/gap/font/padding/radius) and
// `.btn.sm` a smaller version of the same; every visible affordance — border,
// fill, colour — is in a MODIFIER (`.btn.pri`, `.btn.ghost`, `.btn.danger`).
// And `button { border: none; background: none }` in the same file removes what
// the browser would otherwise have drawn, so an unskinned `.btn` is not merely
// plain: it is invisible as a control.
//
// Reported from a real machine (owner 2026-08-25, Windows 10 on 0.3.27):
// 「提示了有新版，但是没有升级的按钮」("it says there's a new version, but there
// is no upgrade button"). Both action buttons on the update path — Download, and
// the install button behind it — were unskinned, one as `btn sm` and one as
// `btn sm primary`, where `primary` is a class this repo has never defined (the
// token is `pri`). The buttons were present, enabled and clickable. Nothing was
// broken in any layer that had a test.
//
// ── WHY A SOURCE SCAN AND NOT A RENDER TEST ─────────────────────────────────
//
// `update-block.test.ts` now asserts the rendered class of those two, which is
// where 0.2.53's law puts a control's verification. That pins the two we know
// about. It cannot pin the THIRD one, which will be written next month in a file
// that does not exist yet — and this defect's whole character is that it does
// not announce itself: no error, no warning, no failing assertion, just a
// control the user does not see. So the fence is repo-wide and static.
//
// ── 🔴 THE RULER IS READ, NOT WRITTEN DOWN ──────────────────────────────────
//
// The set of skins is extracted FROM `tokens.css` rather than listed here. A
// hard-coded `['pri','ghost','danger']` would keep passing after somebody
// renames a token — the test would go on approving a class that no longer paints
// anything, which is this repo's named second shape (「先核你的尺子」: the
// measuring instrument quietly answering a different question). Two ruler
// checks below fail loudly if the extraction stops working.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const TOKENS = fileURLToPath(new URL('../styles/tokens.css', import.meta.url));

/** Every `.vue` under `apps/desktop/src`, recursively. */
function vueFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) vueFiles(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

/**
 * The `.btn` modifiers that actually PAINT, read out of `tokens.css`.
 *
 * A modifier counts only if its block declares `background`, `border` or
 * `color` — `.btn.sm` declares none of those (padding, font-size, radius), and
 * it is exactly the class that made the shipped defect look plausible.
 * Pseudo-class rules (`:hover`, `:disabled`) are skipped: they modify a skin,
 * they are not one.
 */
function paintingSkins(css: string): Set<string> {
  const skins = new Set<string>();
  // 🔴 Comments out first, and the rule pattern excludes braces on BOTH sides.
  // The first version anchored each rule on `(?:^|\})` and matched every OTHER
  // rule, because the `g` flag had already consumed the `}` the next match
  // needed to start from — so `SKINS` came back EMPTY and the door reported all
  // 57 buttons in the tree as unskinned. The two ruler assertions below are the
  // only reason that was caught rather than believed: a blind scanner produces
  // a confident, itemised, entirely wrong list.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // Exactly `.btn.<name>` — no pseudo-class, no descendant, no second
    // element. `.btn.ghost:hover` and `.upd-notice .btn` are not skins.
    const [, selector = '', body = ''] = rule;
    const named = /^\.btn\.([a-z][\w-]*)$/.exec(selector.trim());
    const skin = named?.[1];
    if (!skin) continue;
    // 🔴 Whole property names, anchored at a declaration boundary. `.btn.sm`
    // declares `border-radius`, and a looser test for "border" would have read
    // it as a skin — the door would then have approved the exact class string
    // that shipped the defect. The ruler has to be right about the one case it
    // was built for.
    if (/(?:^|;)\s*(background|background-color|border|border-color|color)\s*:/.test(body)) {
      skins.add(skin);
    }
  }
  return skins;
}

const SKINS = paintingSkins(readFileSync(TOKENS, 'utf8'));

/**
 * Every static `class="btn ..."` in one file's source.
 *
 * 🔴 COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT TIDYING. The first run of
 * this door reported `UpdateBlock.vue: class="btn sm"` on a file that had
 * already been fixed — it was reading the comment written above the fix, which
 * quotes the two broken class strings to explain what went wrong.
 *
 * ⚠️ This is the THIRD time in this card, in a third language. `render()` in
 * `update-block.test.ts` strips comments because a comment explaining "only
 * up_to_date may say up to date" matched a search for that sentence; the Rust
 * ordering guard in `apply_arg_tests.rs` hit it too. Every time, the text that
 * fooled the check was the text written to explain the very rule being checked.
 * ⇒ A scan over source must decide what is CODE before it decides what is
 * wrong, or the most carefully documented fix in the tree is the one that looks
 * broken.
 *
 * Line comments are only stripped when they START a line, so a `https://` in a
 * declaration keeps its slashes.
 */
export function buttonClassesIn(src: string): string[] {
  const code = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/class="(btn(?:\s+[\w-]+)*)"/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

/** Every static `class="btn ..."` in the tree, with its file and value. */
function buttonClasses(): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = [];
  for (const file of vueFiles(SRC)) {
    for (const value of buttonClassesIn(readFileSync(file, 'utf8'))) {
      found.push({ file: file.slice(SRC.length), value });
    }
  }
  return found;
}

describe('button skin door', () => {
  /**
   * 🔴 RULER CHECK ①. If the extraction breaks, every assertion below passes
   * for the wrong reason — an empty skin set would make the door reject
   * everything, and a set built from the layout-only rules would make it accept
   * everything. Both failures are silent without this.
   */
  it('🔴 reads the painting skins out of tokens.css', () => {
    expect(SKINS.has('pri')).toBe(true);
    expect(SKINS.has('ghost')).toBe(true);
    expect(SKINS.has('danger')).toBe(true);
  });

  /**
   * 🔴 RULER CHECK ②, and it is the load-bearing one. `sm` is a `.btn.<name>`
   * rule that paints NOTHING, and treating it as a skin is precisely the
   * mistake this file exists to prevent — a door that accepted `btn sm` would
   * have passed the shipped defect.
   */
  it('🔴 does not mistake the size modifier for a skin', () => {
    expect(SKINS.has('sm')).toBe(false);
  });

  /**
   * 🔴 RULER CHECK ③ — the scanner reads code, not prose about code.
   *
   * Both directions, because only one of them is the bug that happened: a
   * commented-out class must NOT be reported (that false alarm named an
   * already-fixed file), and a real one beside it must still be found (a
   * stripper that ate too much would silence the door instead).
   */
  it('🔴 reads code, not the comments that quote code', () => {
    const src = [
      '<!-- this button WAS class="btn sm" and painted nothing -->',
      '<button class="btn pri sm">ok</button>',
      '/* also not code: class="btn sm primary" */',
      '  // nor this: class="btn"',
    ].join('\n');
    expect(buttonClassesIn(src)).toEqual(['btn pri sm']);
  });

  /** The blind-scan control: a scanner that finds nothing agrees with everything. */
  it('finds the buttons it claims to be checking', () => {
    const all = buttonClasses();
    expect(all.length).toBeGreaterThan(40);
    expect(all.some((b) => b.file.endsWith('UpdateBlock.vue'))).toBe(true);
  });

  /**
   * 🔴 THE DOOR. Every `.btn` in the tree carries at least one painting skin.
   *
   * The failure message names the file and the exact class string, because the
   * fix is one token long and the cost of not knowing which of ~60 buttons it
   * is would be the whole value of the check.
   */
  it('🔴 every .btn carries a skin that paints something', () => {
    const unskinned = buttonClasses().filter(
      (b) => !b.value.split(/\s+/).some((c) => SKINS.has(c)),
    );
    expect(unskinned.map((b) => `${b.file}: class="${b.value}"`)).toEqual([]);
  });

  /**
   * 🔴 `primary` was the second half of the shipped defect: a class name that
   * reads correct, matches no rule, and therefore paints nothing. It is not
   * covered by the door above (which only asks whether SOME class paints), so
   * the near-miss spelling of a real token gets its own assertion.
   */
  it('🔴 nobody writes `primary` for the token named `pri`', () => {
    expect(SKINS.has('primary')).toBe(false);
    const typo = buttonClasses().filter((b) => b.value.split(/\s+/).includes('primary'));
    expect(typo.map((b) => `${b.file}: class="${b.value}"`)).toEqual([]);
  });
});
