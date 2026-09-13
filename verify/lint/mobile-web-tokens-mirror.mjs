// verify/lint/mobile-web-tokens-mirror.mjs
// Card P-1 — the phone's design tokens exist twice: as Dart in
// `apps/mobile/lib/src/ui/tokens.dart` here, and hand-copied into CSS custom
// properties in the browser client's own repository. They must stay equal.
//
// ── WHAT THE PROBLEM ACTUALLY IS ───────────────────────────────────────────
// owner 2026-09-10: 「优化 FLOWMIC-WEB 的转录界面，要求样式与手机端的转录界面样式
// 一致」. The design register for that ruling
// (docs/strategy/2026-09-10-web-mic-visual-parity-with-phone-design.md §3)
// settled WHICH palette the browser mirrors: the PHONE's, not the desktop's.
// That decision has teeth only because the two are known to be different
// contracts — `docs/decisions/2026-07-30-design-tokens-not-a-mirror.md` records
// that 18 same-named tokens agree on zero values between
// `apps/desktop/src/styles/tokens.css` and this file. A browser palette that
// drifts toward the desktop one would still look plausible; it would just stop
// being the thing owner pointed at.
//
// The browser cannot import Dart, so `apps/mic/src/styles/tokens.css` in the
// `flowmic-web` repo re-types the values by hand. Nothing in either repo
// notices when one side moves. This is the thing that notices.
//
// The failure it catches is quiet by construction: a retuned colour still
// renders, still passes contrast in whichever theme it was retuned for, and
// still looks like a palette. The only observable is that two surfaces of one
// product disagree about what「已投递」green is.
//
// ── 🔴 WHAT THIS LINT DOES *NOT* PROVE ─────────────────────────────────────
// It compares literals in two files. It cannot see:
//   · whether any browser component READS a `--fm-*` variable. A tokens file
//     nothing consumes is this repo's #1 historic shape, and comparing it to
//     Dart would go green the whole time. That half is the web repo's own
//     `scripts/design-token-literals.mjs` (no colour literals outside the
//     tokens file) plus card P-2's screen-mounted Playwright assertions on
//     COMPUTED colour;
//   · geometry. Only the numbers that are TOKENS in tokens.dart are compared
//     (see SCALARS). The card radius, chip padding and page gutter the design
//     register lists live as literals inside individual widgets, so there is
//     nothing here for them to be compared against;
//   · optics. `segShadow`'s COLOUR is mirrored; its blur is not, because
//     Flutter's `blurRadius` and CSS's blur-radius are different units
//     (Flutter converts to a Gaussian sigma internally, CSS's radius is 2σ), so
//     a byte-equal number would be a false claim of sameness.
//
// ── 🔴 A MISSING SIBLING IS A SKIP, NEVER A PASS ───────────────────────────
// Same contract as spoken-langs-mirror, and for the same reason: a machine
// without the browser client checked out compared nothing, and「nothing was
// compared」and「nothing had drifted」are different answers. The SKIP prints how
// many tokens went unchecked so the line cannot be read as good news.
//
// ── 🔴 AND A MISSING *MAPPING* IS A FAIL ───────────────────────────────────
// Every colour member of the four mirrored classes must appear in MIRRORED or
// in NOT_MIRRORED. A new token added to tokens.dart therefore fails here on
// the day it arrives, and the person adding it decides — copy it, or write down
// why the browser does not need it. Without that rule the mirror would silently
// cover a shrinking fraction of the palette while printing a growing PASS.
// The reverse rule holds too: an entry naming a member that no longer exists
// fails, because a mapping of a declaration that is gone is a comparison
// nobody is running (design-token-literals' own `findStale` learned this).

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ROOT, readText } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'mobile-web-tokens-mirror';

const DART_FILE = 'apps/mobile/lib/src/ui/tokens.dart';
// 🔴 `flowmic-web` is the BROWSER CLIENT, not the marketing site — the same
// trap spoken-langs-mirror's header records measuring: an override named
// FLOWMIC_WEB_REPO moved three unrelated checks onto the other repository.
// This lint reuses that file's variable, `FLOWMIC_WEB_CLIENT_REPO`.
const WEB_REPO = 'flowmic-web';
const WEB_FILE = 'apps/mic/src/styles/tokens.css';

/** The three CSS scopes the browser file is required to carry, normalised. */
const LIGHT_SCOPE = ':root';
const DARK_MEDIA_SCOPE =
  '@media (prefers-color-scheme: dark) | :root:not([data-theme="light"])';
const DARK_ATTR_SCOPE = ':root[data-theme="dark"]';

// ── the mapping ────────────────────────────────────────────────────────────
// `dartMember: '--css-var'`. A member whose Dart value is a List (a gradient
// pair, a shadow list) maps to an ARRAY of vars, one per colour, in order.

const MIRRORED = {
  // FlowMicDarkColors / FlowMicLightColors — the semantic palette.
  palette: {
    brand: '--fm-brand',
    brandDeep: '--fm-brand-deep',
    brandSoft: '--fm-brand-soft',
    teal: '--fm-teal',
    tealSoft: '--fm-teal-soft',
    amber: '--fm-amber',
    amberSoft: '--fm-amber-soft',
    red: '--fm-red',
    redSoft: '--fm-red-soft',
    green: '--fm-green',
    greenSoft: '--fm-green-soft',
    slate: '--fm-slate',
    slateSoft: '--fm-slate-soft',
    bannerBlockingFill: '--fm-banner-blocking-fill',
    bannerBlockingBorder: '--fm-banner-blocking-border',
    bannerBlockingInk: '--fm-banner-blocking-ink',
    bannerDegradedBorder: '--fm-banner-degraded-border',
    bannerInfoBorder: '--fm-banner-info-border',
    canvas: '--fm-canvas',
    body: '--fm-body',
    surface: '--fm-surface',
    surface2: '--fm-surface2',
    line: '--fm-line',
    t1: '--fm-t1',
    t2: '--fm-t2',
    t3: '--fm-t3',
    onBrandInk: '--fm-on-brand-ink',
    scrim: '--fm-scrim',
  },
  // FlowMicChannelColors — owner 2026-08-01's one channel identity.
  channel: {
    lanInk: '--fm-channel-lan-ink',
    lanSoft: '--fm-channel-lan-soft',
    cloudInk: '--fm-channel-cloud-ink',
    cloudSoft: '--fm-channel-cloud-soft',
  },
  // FlowMicDockColors — the Plan A′ dock, which is what the speak screen's
  // press-to-talk bar and mode control are actually painted with
  // (`apps/mobile/lib/src/ui/ptt_bar.dart` reads `FlowMicDockColors.pri` /
  // `.onPri` / `.recFill` / `.processing` / `.doneFlash` / `.chipbg` / `.sub` /
  // `.recordOnly`; grep that file for `FlowMicDockColors.`).
  dock: {
    bg: '--fm-dock-bg',
    panel: '--fm-dock-panel',
    ink: '--fm-dock-ink',
    sub: '--fm-dock-sub',
    line: '--fm-dock-line',
    pri: '--fm-dock-pri',
    chipbg: '--fm-dock-chipbg',
    onPri: '--fm-dock-on-pri',
    rec: '--fm-dock-rec',
    recFill: '--fm-dock-rec-fill',
    processing: '--fm-dock-processing',
    recordOnly: '--fm-dock-record-only',
    doneFlash: '--fm-dock-done-flash',
    segShadow: ['--fm-dock-seg-shadow-color'],
  },
};

/** Members deliberately not carried into the browser, each with the reason.
 *  Printed on every PASS, so the gap is a visible number rather than a silence. */
const NOT_MIRRORED = {
  palette: {
    pttIdle:
      'legacy gradient pair; the speak screen\'s bar is painted from FlowMicDockColors ' +
      '(ptt_bar.dart). Its remaining callers are connections_page.dart and ' +
      'scan_permission_pane.dart — two screens the browser client does not have',
    pttRec: 'same family as pttIdle',
    pttNoted: 'same family as pttIdle',
    pttProcessingBg: 'alias of amber for the legacy PTT face; the browser uses --fm-dock-processing',
    pttDoneBg: 'alias of green for the legacy PTT face; the browser uses --fm-dock-done-flash',
    pttOnLightInk: 'ink for the legacy PTT faces; the browser uses --fm-dock-on-pri',
    floatShadow:
      'the browser mic page has no floating surface. Its only phone caller is ' +
      'pairing_success_toast.dart, which has no browser counterpart',
  },
  channel: {},
  dock: {
    restoreBg: 'edit-sheet restore strip; the browser has no edit sheet (card P-2 scope ends at the input bar)',
    restoreBorder: 'edit-sheet restore strip — see restoreBg',
    restoreText: 'edit-sheet restore strip — see restoreBg',
    appendHighlight: 'edit-sheet append wash — see restoreBg',
    sheetShadow: 'edit-sheet lift — see restoreBg',
  },
};

/** Theme-invariant numbers that ARE tokens in tokens.dart. Compared as
 *  numbers: the CSS side may carry a unit, this compares what is in front of
 *  it. Everything else the design register lists as geometry is a literal
 *  inside a widget and has no token to be compared against. */
const SCALARS = {
  kTranscriptBodySize: '--fm-text-body',
  kSpeakControlHeight: '--fm-ptt-min-height',
  kSpeakControlRadius: '--fm-radius-ptt',
  kSpeakControlGlyphSize: '--fm-ptt-glyph',
};

const SCALARS_NOT_MIRRORED = {
  kOnboardingTitleSize: 'the first-run guide is a phone-only screen',
  kOnboardingBodySize: 'the first-run guide is a phone-only screen',
  kOnboardingBodyMutedSize: 'the first-run guide is a phone-only screen',
  kOnboardingButtonLabelSize: 'the first-run guide is a phone-only screen',
  kOnboardingSkipSize: 'the first-run guide is a phone-only screen',
};

/** `kBaseText`'s two numbers — a TextStyle getter, not a `const double`, so it
 *  is read separately from SCALARS. */
const BASE_TEXT = { fontSize: '--fm-text-base', height: '--fm-line-base' };

const CLASS_OF_GROUP = {
  palette: { light: 'FlowMicLightColors', dark: 'FlowMicDarkColors' },
  channel: { light: 'FlowMicChannelColors', dark: 'FlowMicChannelColors' },
  dock: { light: 'FlowMicDockColors', dark: 'FlowMicDockColors' },
};

// ── Dart side ──────────────────────────────────────────────────────────────

/**
 * Drop comments so no `;` or `#hex` inside prose can be read as code.
 *
 * 🔴 TRAILING comments have to go too, and that is MEASURED, not assumed: the
 * member regex below ends a declaration at the first `;` that sits at end of
 * line. `static const Color brandSoft = Color(0x24818CF8); // rgba(…)` does not
 * end at end of line, so its match ran on to the NEXT declaration's line ending
 * and swallowed it — the first run of this lint reported 14 tokens as「no
 * longer declared」while every one of them was sitting in the file. A parser
 * that skips a member silently fails the same way a mirror that compares
 * nothing does.
 */
function stripLineComments(text) {
  return (
    text
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      // `(?<!:)` so a `://` inside a value could never be cut in half. No such
      // value is in tokens.dart today; the guard is here so this function does
      // not become the reason there cannot be one.
      .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
      .join('\n')
  );
}

/** The body of `class <name> { … }`, from its opening brace to the `}` that
 *  sits alone in column 0. Every class in tokens.dart is written that way; if
 *  one stops being, this returns null and the caller FAILs rather than
 *  comparing against a truncated body. */
function classBody(text, className) {
  const open = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`).exec(text);
  if (open === null) return null;
  const start = open.index + open[0].length;
  const close = text.indexOf('\n}', start);
  if (close === -1) return null;
  return text.slice(start, close);
}

const MEMBER_RE =
  /^[ \t]*static[ \t]+(?:const[ \t]+)?(Color|List<Color>|List<BoxShadow>)[ \t]+(?:get[ \t]+)?([A-Za-z_]\w*)[ \t]*(?:=>|=)([\s\S]*?);[ \t]*$/gm;

function members(body) {
  const out = new Map();
  MEMBER_RE.lastIndex = 0;
  for (const m of body.matchAll(MEMBER_RE)) {
    out.set(m[2], { type: m[1], expr: m[3].trim() });
  }
  return out;
}

/** Split `FlowMicTheme.isLight ? A : B` at the `:` that is not nested inside
 *  parentheses or brackets. Returns null when the expression is not a ternary
 *  on the theme — those members are theme-invariant by construction. */
function splitThemeTernary(expr) {
  const q = expr.indexOf('?');
  if (!/FlowMicTheme\.isLight/.test(expr) || q === -1) return null;
  let depth = 0;
  for (let i = q + 1; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ':' && depth === 0) {
      return { light: expr.slice(q + 1, i).trim(), dark: expr.slice(i + 1).trim() };
    }
  }
  return null;
}

const HEX_RE = /Color\s*\(\s*0x([0-9a-fA-F]{8})\s*\)/g;

/** ARGB `0xAARRGGBB` -> `{ r, g, b, a }` with `a` kept as the 0-255 integer it
 *  is written as. Alpha is compared as that integer, never as a float: the CSS
 *  side has to write a decimal and the only lossless comparison is back
 *  through `Math.round(alpha * 255)`. */
function argb(hex8) {
  return {
    a: parseInt(hex8.slice(0, 2), 16),
    r: parseInt(hex8.slice(2, 4), 16),
    g: parseInt(hex8.slice(4, 6), 16),
    b: parseInt(hex8.slice(6, 8), 16),
  };
}

const sameColor = (x, y) => x.a === y.a && x.r === y.r && x.g === y.g && x.b === y.b;
const showColor = (c) =>
  c.a === 255
    ? `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join('')}`
    : `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;

/**
 * Resolve one member of one class to its colours in the given theme.
 *
 * Handles the three shapes tokens.dart actually uses: a literal
 * `Color(0x…)` (or a list of them), a theme ternary between two literals, and
 * an ALIAS — `pttProcessingBg = amber`, `bannerBlockingFill =
 * FlowMicDarkColors.bannerBlockingFill`. Aliases are followed, because an
 * alias is still a value and「the light palette borrows the dark one here」is
 * exactly the kind of fact the browser copy has to reproduce.
 */
function resolveColors(byClass, className, member, theme, seen = new Set()) {
  const key = `${className}.${member}`;
  if (seen.has(key)) return { error: `alias cycle at ${key}` };
  seen.add(key);

  const cls = byClass.get(className);
  if (!cls) return { error: `class ${className} is not readable in ${DART_FILE}` };
  const decl = cls.get(member);
  if (!decl) return { error: `${key} is no longer declared in ${DART_FILE}` };

  let expr = decl.expr;
  const ternary = splitThemeTernary(expr);
  if (ternary) expr = theme === 'light' ? ternary.light : ternary.dark;

  HEX_RE.lastIndex = 0;
  const literals = [...expr.matchAll(HEX_RE)].map((m) => argb(m[1]));
  if (literals.length > 0) return { colors: literals };

  // No literal here — it must be an alias to another member.
  const qualified = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/.exec(expr);
  if (qualified) return resolveColors(byClass, qualified[1], qualified[2], theme, seen);
  const bare = /^([A-Za-z_]\w*)$/.exec(expr.trim());
  if (bare) return resolveColors(byClass, className, bare[1], theme, seen);

  return { error: `${key} in the ${theme} theme resolves to no Color literal (expression: ${expr})` };
}

// ── CSS side ───────────────────────────────────────────────────────────────

/** Declarations of `--*` custom properties, keyed by the normalised selector
 *  path they sit under. A hand-rolled walker rather than a dependency: the
 *  file it reads is one this repo's own card wrote, and its shape is pinned by
 *  the three scope names above. */
/** Selector text as a comparable key. Quotes are normalised because CSS does
 *  not distinguish `[data-theme="dark"]` from `[data-theme='dark']` and
 *  prettier rewrites one into the other — measured on the browser client's own
 *  tree: this parser reported both dark blocks MISSING immediately after
 *  `prettier --write`. A gate that fails on a formatter is a gate people learn
 *  to ignore. */
function normaliseSelector(text) {
  return text.trim().replace(/\s+/g, ' ').replace(/'/g, '"');
}

function parseCssScopes(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const scopes = new Map();
  const stack = [];
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') {
      stack.push(normaliseSelector(buf));
      buf = '';
    } else if (c === '}') {
      flush(scopes, stack, buf);
      buf = '';
      stack.pop();
    } else if (c === ';') {
      flush(scopes, stack, buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  return scopes;
}

function flush(scopes, stack, buf) {
  const decl = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(buf);
  if (decl === null || stack.length === 0) return;
  const key = stack.join(' | ');
  if (!scopes.has(key)) scopes.set(key, new Map());
  scopes.get(key).set(decl[1], decl[2].replace(/\s+/g, ' '));
}

/** `#RGB` / `#RRGGBB` / `#RRGGBBAA` / `rgb()` / `rgba()` -> the same
 *  `{ r, g, b, a }` shape the Dart side produces, with `a` as a 0-255 integer.
 *  Anything else (a `var()`, a keyword, a gradient) returns null and the
 *  caller reports it as unreadable rather than as equal. */
function parseCssColor(value) {
  const v = value.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
    };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(v);
  if (fn === null) return null;
  const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  const alpha = parts.length >= 4 ? parts[3] : 1;
  return { r: parts[0], g: parts[1], b: parts[2], a: Math.round(alpha * 255) };
}

const parseCssNumber = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)/.exec(value.trim());
  return m === null ? null : Number(m[1]);
};

// ── sibling discovery (verbatim contract from spoken-langs-mirror) ─────────

function searchRoots() {
  const roots = [path.dirname(ROOT)];
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) {
      const mainParent = path.dirname(path.dirname(commonDir));
      if (mainParent && !roots.includes(mainParent)) roots.push(mainParent);
    }
  } catch {
    // Not a git checkout, or no git on PATH — this only ever ADDS a place to look.
  }
  // 🔴 The override REPLACES the search. Falling back to a discovered sibling
  // when the override is wrong would print a PASS about a repository nobody
  // asked about — see spoken-langs-mirror's header.
  const override = process.env.FLOWMIC_WEB_CLIENT_REPO;
  if (override) return [{ dir: path.resolve(override), viaEnv: true }];
  return roots.map((r) => ({ dir: path.join(r, WEB_REPO), viaEnv: false }));
}

// ── the check ──────────────────────────────────────────────────────────────

/**
 * Everything the Dart side asks of the browser file: `{ expected, expectedScalars }`,
 * or `{ error }` carrying the FAIL this suite would report.
 *
 * Exported so the drill (`scripts/mobile-web-tokens-mirror-lint.test.mjs`) can
 * build a CSS fixture that AGREES with the real tokens.dart and then break one
 * byte of it. That isolates what the drill is for — proving the comparator and
 * the CSS parser can go red — from what only the lint itself can answer, which
 * is whether the real browser file agrees.
 *
 * @param {string} dartRaw the raw contents of tokens.dart
 */
export function expectations(dartRaw) {
  const dartText = stripLineComments(dartRaw);

  // Read every mirrored class once.
  const byClass = new Map();
  for (const className of [
    'FlowMicDarkColors',
    'FlowMicLightColors',
    'FlowMicChannelColors',
    'FlowMicDockColors',
  ]) {
    const body = classBody(dartText, className);
    if (body === null) {
      return {
        error: {
        status: 'FAIL',
        detail:
          `class ${className} is no longer readable in ${DART_FILE} (renamed, moved, or its closing brace ` +
          'is no longer in column 0). The browser mirror would now be compared against nothing. ' +
          'Update verify/lint/mobile-web-tokens-mirror.mjs.',
        },
      };
    }
    byClass.set(className, members(body));
  }

  // ── mapping completeness, both directions ────────────────────────────────
  const mappingProblems = [];
  for (const group of Object.keys(MIRRORED)) {
    const { light, dark } = CLASS_OF_GROUP[group];
    const declared = new Set([
      ...Object.keys(MIRRORED[group]),
      ...Object.keys(NOT_MIRRORED[group]),
    ]);
    for (const className of new Set([light, dark])) {
      for (const member of byClass.get(className).keys()) {
        if (!declared.has(member)) {
          mappingProblems.push(
            `${className}.${member} is a token this lint has never been told about. Either mirror it into ` +
              `${WEB_FILE} and add it to MIRRORED.${group}, or add it to NOT_MIRRORED.${group} with the reason ` +
              'the browser does not need it.',
          );
        }
      }
    }
    for (const member of declared) {
      const inLight = byClass.get(light).has(member);
      const inDark = byClass.get(dark).has(member);
      if (!inLight || !inDark) {
        mappingProblems.push(
          `${group}.${member} is named by this lint but is no longer declared in ` +
            `${!inDark ? dark : light} — a mapping of a declaration that is gone compares nothing`,
        );
      }
    }
  }
  const scalarDecls = new Map(
    [...dartText.matchAll(/^const\s+double\s+(k\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/gm)].map((m) => [
      m[1],
      Number(m[2]),
    ]),
  );
  for (const k of scalarDecls.keys()) {
    if (!(k in SCALARS) && !(k in SCALARS_NOT_MIRRORED)) {
      mappingProblems.push(
        `${k} is a new numeric token in ${DART_FILE} that this lint has never been told about — ` +
          'add it to SCALARS or to SCALARS_NOT_MIRRORED.',
      );
    }
  }
  for (const k of [...Object.keys(SCALARS), ...Object.keys(SCALARS_NOT_MIRRORED)]) {
    if (!scalarDecls.has(k)) {
      mappingProblems.push(`${k} is named by this lint but is no longer declared in ${DART_FILE}`);
    }
  }
  const baseText = /TextStyle\s+get\s+kBaseText\s*=>\s*TextStyle\(([\s\S]*?)\);/.exec(dartText);
  const baseNums = {};
  if (baseText === null) {
    mappingProblems.push(
      `kBaseText is no longer a plain TextStyle literal in ${DART_FILE} — its fontSize/height would be ` +
        'compared against nothing',
    );
  } else {
    for (const field of Object.keys(BASE_TEXT)) {
      const hit = new RegExp(`${field}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(baseText[1]);
      if (hit === null) mappingProblems.push(`kBaseText no longer carries a literal ${field}`);
      else baseNums[field] = Number(hit[1]);
    }
  }
  if (mappingProblems.length > 0) {
    return { error: { status: 'FAIL', detail: mappingProblems.join(' | ') } };
  }

  // ── resolve every mirrored value on the Dart side ────────────────────────
  /** @type {Array<{ var: string, light: object, dark: object, source: string }>} */
  const expected = [];
  for (const group of Object.keys(MIRRORED)) {
    const { light, dark } = CLASS_OF_GROUP[group];
    for (const [member, target] of Object.entries(MIRRORED[group])) {
      const vars = Array.isArray(target) ? target : [target];
      const l = resolveColors(byClass, light, member, 'light');
      const d = resolveColors(byClass, dark, member, 'dark');
      if (l.error || d.error) {
        return { error: { status: 'FAIL', detail: l.error ?? d.error } };
      }
      if (l.colors.length < vars.length || d.colors.length < vars.length) {
        return {
          error: {
            status: 'FAIL',
            detail:
              `${group}.${member} resolves to ${l.colors.length} light / ${d.colors.length} dark colour(s) but ` +
              `this lint maps ${vars.length} variable(s) onto it — the declaration changed shape`,
          },
        };
      }
      vars.forEach((cssVar, i) => {
        expected.push({ var: cssVar, light: l.colors[i], dark: d.colors[i], source: `${group}.${member}` });
      });
    }
  }

  const expectedScalars = [];
  for (const [k, cssVar] of Object.entries(SCALARS)) {
    expectedScalars.push({ var: cssVar, value: scalarDecls.get(k), source: k });
  }
  for (const [field, cssVar] of Object.entries(BASE_TEXT)) {
    expectedScalars.push({ var: cssVar, value: baseNums[field], source: `kBaseText.${field}` });
  }

  return { expected, expectedScalars };
}

/**
 * @param {{dartFile?: string, cssFile?: string}} [overrides]
 *   Absolute paths, for the drill. They point the same comparison at fixtures;
 *   neither can turn a FAIL into a PASS, and the path that was read is printed.
 */
export default async function run(overrides = {}) {
  const dartPath = overrides.dartFile ?? path.join(ROOT, DART_FILE);
  const dartRaw = await readText(dartPath);
  if (dartRaw === null) {
    return {
      status: 'FAIL',
      detail: `${DART_FILE} is missing — it is the palette the browser client's tokens.css is compared against`,
    };
  }
  const built = expectations(dartRaw);
  if (built.error) return built.error;
  const { expected, expectedScalars } = built;
  const unchecked = expected.length + expectedScalars.length;

  // ── the browser side. It lives in a sibling repo, so absence is a SKIP. ──
  let cssText = null;
  let cssWhere = null;
  const tried = [];
  if (overrides.cssFile) {
    tried.push(overrides.cssFile);
    cssText = await readText(overrides.cssFile);
    cssWhere = { dir: path.dirname(overrides.cssFile), viaEnv: false, explicit: true };
  } else {
    for (const candidate of searchRoots()) {
      const abs = path.join(candidate.dir, WEB_FILE);
      tried.push(abs);
      try {
        cssText = await readFile(abs, 'utf8');
        cssWhere = candidate;
        break;
      } catch {
        /* not here; try the next root */
      }
    }
  }
  if (cssText === null) {
    return {
      status: 'SKIP',
      detail:
        `the ${WEB_REPO} repository is not checked out on this machine, so NONE of the ${unchecked} token(s) ` +
        `${WEB_FILE} mirrors were compared against ${DART_FILE} — nothing about that mirror was checked here. ` +
        `Looked in: ${tried.join(', ')}. Set FLOWMIC_WEB_CLIENT_REPO to point at the checkout.`,
    };
  }
  // The exact path that was read, printed on every outcome. A mirror that does
  // not say which tree it compared is one machine-layout change away from being
  // a confident answer about a repository nobody asked about.
  const shown = cssWhere.explicit
    ? tried[0]
    : cssWhere.viaEnv
      ? `${cssWhere.dir} (FLOWMIC_WEB_CLIENT_REPO)/${WEB_FILE}`
      : `${cssWhere.dir}/${WEB_FILE}`;

  const scopes = parseCssScopes(cssText);
  const lightScope = scopes.get(LIGHT_SCOPE);
  const darkMedia = scopes.get(DARK_MEDIA_SCOPE);
  const darkAttr = scopes.get(DARK_ATTR_SCOPE);
  const missingScopes = [];
  if (!lightScope) missingScopes.push(`\`${LIGHT_SCOPE}\` (the light palette)`);
  if (!darkMedia) missingScopes.push(`\`${DARK_MEDIA_SCOPE}\` (the system-dark palette)`);
  if (!darkAttr) missingScopes.push(`\`${DARK_ATTR_SCOPE}\` (the explicit dark choice)`);
  if (missingScopes.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${shown} is missing ${missingScopes.join(' and ')}. The browser's theme is tri-state like ` +
        "the phone's (AppThemeMode.system / light / dark): the bare `:root` carries light, the media query " +
        'carries system-dark guarded against an explicit light choice, and the attribute selector lets the ' +
        'explicit dark choice win. A palette that only answers two of those three has a state with no colours.',
    };
  }

  /** Resolved value of a variable in a dark scope: what the cascade actually
   *  produces, so a token equal in both themes may legitimately be declared
   *  once. */
  const inDark = (scope, cssVar) => scope.get(cssVar) ?? lightScope.get(cssVar);

  const problems = [];
  for (const item of expected) {
    const rawLight = lightScope.get(item.var);
    if (rawLight === undefined) {
      problems.push(`${item.var} (${item.source}) is not declared on \`${LIGHT_SCOPE}\``);
      continue;
    }
    const gotLight = parseCssColor(rawLight);
    if (gotLight === null) {
      problems.push(`${item.var} on \`${LIGHT_SCOPE}\` is \`${rawLight}\`, which is not a colour this lint can read`);
    } else if (!sameColor(gotLight, item.light)) {
      problems.push(
        `${item.var} light: ${DART_FILE} ${item.source} = ${showColor(item.light)} but ` +
          `${WEB_FILE} \`${LIGHT_SCOPE}\` = ${rawLight}`,
      );
    }
    for (const [label, scope] of [
      ['prefers-color-scheme: dark', darkMedia],
      ['[data-theme="dark"]', darkAttr],
    ]) {
      const raw = inDark(scope, item.var);
      const got = raw === undefined ? null : parseCssColor(raw);
      if (got === null) {
        problems.push(
          `${item.var} under \`${label}\` resolves to ${raw === undefined ? 'nothing' : `\`${raw}\``}, ` +
            'which is not a colour this lint can read',
        );
      } else if (!sameColor(got, item.dark)) {
        problems.push(
          `${item.var} dark (${label}): ${DART_FILE} ${item.source} = ${showColor(item.dark)} but ` +
            `${WEB_FILE} = ${raw}`,
        );
      }
    }
  }

  for (const item of expectedScalars) {
    const raw = lightScope.get(item.var);
    if (raw === undefined) {
      problems.push(`${item.var} (${item.source}) is not declared on \`${LIGHT_SCOPE}\``);
      continue;
    }
    const got = parseCssNumber(raw);
    if (got === null) problems.push(`${item.var} is \`${raw}\`, which starts with no number`);
    else if (got !== item.value) {
      problems.push(
        `${item.var}: ${DART_FILE} ${item.source} = ${item.value} but ${WEB_FILE} = ${raw}`,
      );
    }
  }

  if (problems.length > 0) {
    return {
      status: 'FAIL',
      detail:
        problems.join(' | ') +
        ` — the phone and the browser client disagree about the design tokens. The phone is the ruler ` +
        `(owner 2026-09-10): a retune in ${DART_FILE} must be hand-copied into ${WEB_FILE} in the ` +
        `${WEB_REPO} repo, and a value invented in ${WEB_REPO} must be reverted there.`,
    };
  }

  const skippedColours = Object.values(NOT_MIRRORED).reduce((n, g) => n + Object.keys(g).length, 0);
  const skippedScalars = Object.keys(SCALARS_NOT_MIRRORED).length;
  return {
    status: 'PASS',
    detail:
      `${expected.length} colour + ${expectedScalars.length} numeric token(s) agree between ${DART_FILE} ` +
      `and ${shown} in both themes (light \`:root\`, system-dark, explicit dark); ` +
      `${skippedColours} colour + ${skippedScalars} numeric token(s) are deliberately not mirrored`,
  };
}
