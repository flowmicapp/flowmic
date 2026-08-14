// scripts/report-design-tokens.mjs
// desktop↔mobile design-token comparison REPORT — a one-shot tool, NOT a lint.
//
// GA-23 registered a "desktop↔mobile tokens check script" assuming the two palettes
// are one SSOT that had drifted in ~11 places. Running this told us otherwise:
// of the 18 tokens whose names match on both sides, **0 agree and 18 differ**,
// in both themes. They are not a drifted mirror — they are two independent
// frozen design contracts (desktop.html vs mobile.html), and each side's own
// file says so. So an equality lint has no invariant to guard: it could only
// pass by whitelisting 100% of its own subject, which is the stub-that-lies
// shape this repo already carries one of (timeline-e2e-prefix).
//
// Hence: kept as a report you run when touching either palette, and left OUT of
// verify:lint. Ruling + the real follow-up guard (ban hardcoded colours outside
// these two files) — docs/decisions/2026-07-30-design-tokens-not-a-mirror.md.
//
// Run: node scripts/report-design-tokens.mjs

import path from 'node:path';
import { ROOT, readText } from '../verify/lint/_util.mjs';

const CSS_PATH = 'apps/desktop/src/styles/tokens.css';
const DART_PATH = 'apps/mobile/lib/src/ui/tokens.dart';

// Explicit dartName -> cssVar. Only pairs whose semantic identity is clear
// from the shared name. Anything uncertain stays out (listed under unmapped).
const MIRROR = {
  brand: '--brand',
  brandSoft: '--brand-soft',
  teal: '--teal',
  tealSoft: '--teal-soft',
  amber: '--amber',
  amberSoft: '--amber-soft',
  red: '--red',
  redSoft: '--red-soft',
  green: '--green',
  greenSoft: '--green-soft',
  slate: '--slate',
  canvas: '--canvas',
  surface: '--surface',
  surface2: '--surface-2',
  line: '--line',
  t1: '--t1',
  t2: '--t2',
  t3: '--t3',
};

/** Parse `:root { … }` (light) and `:root[data-theme="dark"] { … }` (dark). */
function parseCssBlocks(text) {
  const light = {};
  const dark = {};
  // Match the two theme blocks; attribute quotes may be ' or ".
  const lightRe = /:root\s*\{([^}]+)\}/;
  const darkRe = /:root\[data-theme=['"]dark['"]\]\s*\{([^}]+)\}/;
  const lm = lightRe.exec(text);
  const dm = darkRe.exec(text);
  if (lm) Object.assign(light, parseCssDecls(lm[1]));
  if (dm) Object.assign(dark, parseCssDecls(dm[1]));
  return { light, dark };
}

function parseCssDecls(body) {
  const out = {};
  // `--name: value;` — strip /* comments */ first so they don't poison values.
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Parse FlowMicDarkColors / FlowMicLightColors Color(0xAARRGGBB) pairs. */
function parseDartPairs(text) {
  const dark = parseDartClass(text, 'FlowMicDarkColors');
  const light = parseDartClass(text, 'FlowMicLightColors');
  const names = new Set([...Object.keys(dark), ...Object.keys(light)]);
  const pairs = {};
  for (const n of names) {
    pairs[n] = { dark: dark[n] ?? null, light: light[n] ?? null };
  }
  return pairs;
}

function parseDartClass(text, className) {
  // Grab the class body up to the next top-level `class ` or EOF.
  const re = new RegExp(
    `class\\s+${className}\\s*\\{[\\s\\S]*?\\n\\}`,
  );
  const m = re.exec(text);
  if (!m) return {};
  const body = m[0];
  const out = {};
  // Only solid Color(0xAARRGGBB) scalars — skip List<Color> gradients.
  const colorRe =
    /static\s+const\s+Color\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)/g;
  let cm;
  while ((cm = colorRe.exec(body)) !== null) {
    out[cm[1]] = argbToCss(cm[2]);
  }
  // Aliases like `static const Color pttProcessingBg = amber;` resolve later.
  const aliasRe =
    /static\s+const\s+Color\s+(\w+)\s*=\s*(\w+)\s*;/g;
  let am;
  while ((am = aliasRe.exec(body)) !== null) {
    if (am[2] === 'Color') continue; // already handled by colorRe
    if (out[am[2]]) out[am[1]] = out[am[2]];
  }
  return out;
}

/** ARGB hex (8 digits) → #rrggbb or rgba(r,g,b,a) when alpha ≠ FF. */
function argbToCss(argb) {
  const a = parseInt(argb.slice(0, 2), 16);
  const r = parseInt(argb.slice(2, 4), 16);
  const g = parseInt(argb.slice(4, 6), 16);
  const b = parseInt(argb.slice(6, 8), 16);
  if (a === 255) {
    return `#${argb.slice(2).toLowerCase()}`;
  }
  // Keep two decimal places to match the demo's .14 / .13 style.
  const alpha = Math.round((a / 255) * 100) / 100;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Normalize for equality: lowercase hex, collapse rgba whitespace/zeros. */
function normalize(v) {
  if (v == null) return null;
  let s = String(v).trim().toLowerCase();
  // #RGB → #RRGGBB
  if (/^#[0-9a-f]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  // #fff / #ffffff already fine; strip trailing zeros on rgba alpha: .16 / 0.16
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(s);
  if (rgba) {
    const a = Number(rgba[4]);
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${a})`;
  }
  // CSS shorthand `#fff` already handled; also accept `rgb(...)` as-is lowercased.
  return s;
}

function buildReport(css, dart) {
  const lines = [];
  lines.push('=== desktop↔mobile design-token comparison (report only, NOT a gate) ===');
  lines.push('');
  lines.push('--- mapped ---');
  let match = 0;
  let drift = 0;
  for (const [dartName, cssVar] of Object.entries(MIRROR)) {
    const d = dart[dartName] ?? { dark: null, light: null };
    const cssDark = css.dark[cssVar] ?? null;
    const cssLight = css.light[cssVar] ?? null;
    const darkOk = normalize(cssDark) === normalize(d.dark);
    const lightOk = normalize(cssLight) === normalize(d.light);
    if (darkOk && lightOk) match++;
    else drift++;
    lines.push(
      `${dartName} ↔ ${cssVar}` +
        `  dark: css=${cssDark ?? '(missing)'} dart=${d.dark ?? '(missing)'} ${darkOk ? 'OK' : 'DRIFT'}` +
        `  | light: css=${cssLight ?? '(missing)'} dart=${d.light ?? '(missing)'} ${lightOk ? 'OK' : 'DRIFT'}`,
    );
  }
  lines.push('');
  lines.push(`mapped summary: ${match} match / ${drift} drift (of ${Object.keys(MIRROR).length})`);
  lines.push('');

  const mappedDart = new Set(Object.keys(MIRROR));
  const mappedCss = new Set(Object.values(MIRROR));
  // Gradient List<Color> tokens are intentionally not parsed as scalars;
  // surface them here so the coordinator sees the full dart inventory.
  const dartGradients = ['pttIdle', 'pttRec', 'pttNoted'];
  const unmappedDart = [
    ...new Set([
      ...Object.keys(dart).filter((n) => !mappedDart.has(n)),
      ...dartGradients,
    ]),
  ].sort();
  // CSS vars that are colour-like (hex/rgba) and not in the mirror.
  const colourish = (v) =>
    typeof v === 'string' && (/^#/.test(v) || /^rgba?\(/i.test(v));
  const unmappedCss = [
    ...new Set([...Object.keys(css.light), ...Object.keys(css.dark)]),
  ]
    .filter((v) => !mappedCss.has(v))
    .filter((v) => colourish(css.light[v]) || colourish(css.dark[v]))
    .sort();

  lines.push('--- unmapped (not guessed; coordinator decides) ---');
  lines.push(`dart-only / uncertain: ${unmappedDart.join(', ') || '(none)'}`);
  lines.push(`css colour vars not mirrored: ${unmappedCss.join(', ') || '(none)'}`);
  lines.push('');
  lines.push(
    'NOTE: brandDeep / slateSoft / body / ptt* left unmapped on purpose —',
  );
  lines.push(
    'naming does not uniquely identify a CSS counterpart (do not guess).',
  );
  return lines.join('\n');
}

const cssText = await readText(path.join(ROOT, CSS_PATH));
const dartText = await readText(path.join(ROOT, DART_PATH));
if (cssText === null || dartText === null) {
  // A report that cannot read its subject must say so and fail — a silent
  // empty table would read as 「no drift」.
  console.error(
    `missing tokens source: css=${cssText === null ? 'MISSING' : 'ok'} dart=${dartText === null ? 'MISSING' : 'ok'}`,
  );
  process.exit(1);
}
process.stdout.write(buildReport(parseCssBlocks(cssText), parseDartPairs(dartText)) + '\n');
