// verify/lint/i18n-add-locale-cost.mjs
//
// 🔴 THE GATE FOR THE ONE REQUIREMENT OWNER ACTUALLY STATED.
//
// owner 2026-08-14: "design a relatively more complete scheme to support later
// language expansion… more may be added; each new language should go smoothly and not require touching too many things."
//
// Everything else in the locale work — the registry, the generators, the
// per-locale data files — is a means. THIS is the end, and it is the only part
// that can rot silently. Nine languages will ship and look fine; then someone
// adds a tenth, hand-writes a tenth branch into a switch "just this once"
// because it is faster than regenerating, and the property is gone. Nothing
// fails, nothing is red, and the cost of language eleven is back where it was.
//
// So the property is measured, not remembered: this lint counts places in
// HAND-WRITTEN source that enumerate the product's UI languages by hand. The
// SSOT is packages/protocol/src/locales.ts; every other enumeration is a copy
// that a new language has to be threaded into.
//
// It runs on the BASELINE pattern this repo already uses for
// design-token-literals and coordinate-anchors: the current count is pinned, new
// ones fail. A big-bang cleanup is not the goal and never was — the goal is that
// the number only goes down.
//
// ⚠️ WHAT THIS CANNOT SEE, stated so nobody reads a green as more than it is:
//   · a hand-written enumeration that never names a locale code (e.g. a list of
//     four labels in display order, keyed by index);
//   · anything outside this repo — the web and admin repos have their own copies
//     and their own gates;
//   · generated files, which are excluded ON PURPOSE: a generator emitting nine
//     branches is the mechanism working, not a violation of it.

import path from 'node:path';
import { ROOT, walk, readText, rel, lineOf, DEFAULT_SKIP_DIRS } from './_util.mjs';

/** Locale identifiers as they appear in each language's syntax. Two or more of
 *  these inside one small window is a hand-rolled locale list. */
const CODE_TOKENS = [
  // wire/storage form
  "'zh-CN'", '"zh-CN"', "'zh_CN'", '"zh_CN"',
  // the Dart enum
  'AppLocale.zh', 'AppLocale.en', 'AppLocale.ja', 'AppLocale.ko',
  // the desktop TS union / the Rust enum
  "'ja'", "'ko'", 'UiLocale::ZhCn', 'UiLocale::En', 'UiLocale::Ja', 'UiLocale::Ko',
  // 🔴 The generated Dart catalogue classes (0.2.67 P1). Added the day the
  // migration landed, and added BECAUSE OF IT: naming a concrete class is the
  // other way to spell 「this language」 in Dart, and 34 test fixtures moved from
  // `AppStrings(AppLocale.zh)` to `const AppStringsZh()` to stay compile-time
  // constants. Without this row the gate would have reported the migration as a
  // one-site improvement while a four-language enumeration simply changed
  // spelling and walked out of view — the ruler answering a question it was no
  // longer being asked. A single `AppStringsZh()` is still fine (MIN_DISTINCT is
  // 3); what this catches is four of them side by side.
  'AppStringsZh', 'AppStringsEn', 'AppStringsJa', 'AppStringsKo',
];

/** A window of this many characters. Short on purpose: it is meant to catch a
 *  LIST (`['zh-CN','en','ja','ko']`, a four-arm match, a four-entry map), not two
 *  unrelated mentions that happen to share a file. */
const WINDOW = 240;
/** How many distinct locale tokens inside one window make it an enumeration.
 *  Three, not two: a pair like `zh`/`en` legitimately appears where the two
 *  AUTHORED languages are contrasted (the registry marks them `authored`), and
 *  flagging that would be flagging the design. */
const MIN_DISTINCT = 3;

const SRC_EXT = new Set(['.ts', '.tsx', '.dart', '.rs', '.vue', '.mjs']);

function isGenerated(relPath, text) {
  if (/\.g\.(dart|ts|rs)$/.test(relPath)) return true;
  if (relPath.includes('/generated/') || relPath.includes('/l10n/')) return true;
  // The house banner. Checked in the first few lines only, so a file merely
  // MENTIONING the phrase is not excused.
  return /GENERATED\s+—\s+DO NOT EDIT BY HAND/.test(text.slice(0, 400));
}

function isExempt(relPath) {
  // The SSOT itself must list every language — that is its job.
  if (relPath === 'packages/protocol/src/locales.ts') return true;
  // This lint names the tokens it hunts for.
  if (relPath === 'verify/lint/i18n-add-locale-cost.mjs') return true;
  // …and so does its baseline, whose header explains WHAT the counted sites
  // are by quoting them (2026-08-14: the header's example tokens landed inside
  // one 240-char window and the gate flagged its own ledger — a ruler reading
  // itself, not a hand-rolled locale list).
  if (relPath === 'verify/lint/i18n-add-locale-cost-baseline.mjs') return true;
  // Legacy reference sources are not shipped and are not maintained.
  if (relPath.startsWith('docs/legacy-reference')) return true;
  return false;
}

function findSites(text) {
  const hits = [];
  for (const tok of CODE_TOKENS) {
    let i = text.indexOf(tok);
    while (i !== -1) {
      hits.push({ at: i, tok });
      i = text.indexOf(tok, i + 1);
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const sites = [];
  let cursor = -1;
  for (let i = 0; i < hits.length; i += 1) {
    if (hits[i].at <= cursor) continue;
    const window = hits.filter((h) => h.at >= hits[i].at && h.at < hits[i].at + WINDOW);
    const distinct = new Set(window.map((h) => h.tok));
    if (distinct.size >= MIN_DISTINCT) {
      sites.push({ at: hits[i].at, tokens: [...distinct] });
      cursor = hits[i].at + WINDOW;
    }
  }
  return sites;
}

/** Collect the offenders. Exported so the baseline is generated by the SAME code
 *  path the gate uses — a baseline produced by a second, similar scanner is the
 *  classic way a gate ends up pinned to a list it does not actually compute. */
export async function collect() {
  const offenders = [];
  let scanned = 0;
  for (const abs of await walk(ROOT, { skipDir: (b) => DEFAULT_SKIP_DIRS.has(b) })) {
    if (!SRC_EXT.has(path.extname(abs))) continue;
    const r = rel(abs).split(path.sep).join('/');
    if (isExempt(r)) continue;
    const text = await readText(abs);
    if (text === null) continue;
    if (isGenerated(r, text)) continue;
    scanned += 1;
    // `#` not `:` between path and line, following coordinate-anchors-baseline's
    // own precedent: a `path.ts:123` string in a checked-in file is picked up by
    // the coordinate-anchors gate as a CLAIM about that line, so a baseline
    // written with colons makes one gate manufacture 54 failures for another.
    const n = findSites(text).length;
    // 🔴 PER-FILE COUNT, NOT PER-LINE. The first cut pinned `path#line`, and it
    // churned three times in one afternoon: every edit ABOVE a hand-rolled list
    // shifts its line, so the gate reported 6 「NEW」 sites that were the same 6
    // sites one comment lower. A baseline that cries wolf on unrelated edits is
    // one people re-pin without reading, which is the same as not having it.
    // A count per file keeps the property that matters — a NEW list anywhere,
    // including a second one in a file already listed, still goes red — while
    // being blind to the thing that is not a change at all.
    if (n > 0) offenders.push(`${r}#${n}`);
  }
  offenders.sort();
  return { offenders, scanned };
}

export default async function run() {
  const { offenders, scanned } = await collect();

  let baseline = null;
  try {
    ({ SITES: baseline } = await import('./i18n-add-locale-cost-baseline.mjs'));
  } catch {
    baseline = null;
  }
  if (!baseline) {
    return {
      status: 'FAIL',
      detail:
        `no baseline yet — ${offenders.length} hand-rolled locale list(s) across ${scanned} hand-written file(s). ` +
        'Pin them in verify/lint/i18n-add-locale-cost-baseline.mjs (export const SITES = [...]).',
    };
  }
  const pinned = new Set(baseline);
  const added = offenders.filter((o) => !pinned.has(o));
  const gone = [...pinned].filter((p) => !offenders.includes(p));
  if (added.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${added.length} file(s) gained a hand-rolled locale list — adding a language must not mean editing these. ` +
        'Derive from packages/protocol/src/locales.ts instead ' +
        '(docs/strategy/2026-08-14-locale-expansion-architecture.md §2). New: ' +
        `${added.slice(0, 8).join(', ')}${added.length > 8 ? ' …' : ''}`,
    };
  }
  return {
    status: 'PASS',
    detail:
      `${offenders.reduce((n, o) => n + Number(o.split('#')[1] ?? 0), 0)} hand-rolled locale list(s) ` +
      `in ${offenders.length} file(s) (baseline ${pinned.size} file(s)` +
      `${gone.length ? `, ${gone.length} retired since` : ''}) across ${scanned} hand-written file(s); ` +
      'generated files excluded by design',
  };
}
