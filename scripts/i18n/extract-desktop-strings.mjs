#!/usr/bin/env node
// scripts/i18n/extract-desktop-strings.mjs
//
// Extract the DESKTOP WEBVIEW string catalogue into data files, so the locale
// expansion (4 -> 9 languages, docs/strategy/2026-08-14-locale-expansion-
// architecture.md §4.2) is one JSON file per language instead of a fifth block
// hand-added to fifteen shards.
//
// 🔴 WHY A PARSER AND NOT A REGEX. A TypeScript catalogue value can be a quoted
// string containing `'`, `,`, `{`, `//` and `*/`; a member expression
// (`TIMELINE_STRINGS['zh-CN'].st_injected` — the same-source references card IJ-02
// installed on purpose); or an arrow function whose body is a template literal
// with nested `${…}` holes and a ternary. All three shapes are in this
// catalogue today. A regex that "mostly works" mis-slices a handful out of ~700
// and the damage is invisible: the file still compiles and one string is quietly
// wrong in one language. So this walks the source with a small state machine and
// REFUSES anything it cannot parse exactly, rather than guessing.
//
// 🔴 THE VALUES WRITTEN OUT ARE TS SOURCE, NOT PLAIN TEXT — the same convention
// the mobile catalogue uses (i18n/mobile/en.json holds Dart source). A value
// carries its own quotes and escapes, and a multi-line value is an ARRAY of
// source lines rather than a reflowed single line. Re-encoding a decoded string
// is exactly how a migration silently re-quotes something wrong.
//
//
// 🔴 THIS PAIR HAS ALREADY RUN, AND ITS INPUT NO LONGER EXISTS. The shards now
// declare key contracts (`export const NAV_KEYS = [...]`) instead of four
// per-locale blocks, so `parseCatalogue(src, 'NAV_STRINGS')` throws 「not
// found」 — that is the migration having happened, not a defect. Kept, and kept
// runnable-looking, for two reasons that are worth the confusion this note
// exists to prevent: it is the record of HOW the data files were produced (the
// only answer to 「where did i18n/desktop/en.json come from」), and its parser
// is imported by migrate-desktop.mjs and snapshot-desktop-rendered.mjs.
// Same shape and same decision as scripts/i18n/extract-mobile-strings.mjs.
//
// Usage:
//   node scripts/i18n/extract-desktop-strings.mjs            # write i18n/desktop/*
//   node scripts/i18n/extract-desktop-strings.mjs --stdout   # report only

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readUiLocales } from './locale-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const SHARD_DIR = path.join(ROOT, 'apps', 'desktop', 'src', 'lib', 'strings');
export const DATA_REL = 'i18n/desktop';
const DATA_DIR = path.join(ROOT, DATA_REL);

/** The locales the source catalogue is written in are DISCOVERED, not listed:
 *  they are whatever per-locale blocks a shard declares, in source order, each
 *  checked against the registry. That is a real property and not tidiness —
 *  「which languages does this source have」 and 「which languages does the
 *  product have」 are two questions (the migration is a pure refactor: the
 *  answers are equal today and the code must not assume it), and writing the
 *  first one down by hand would have put a fifth hand-rolled locale list into
 *  the very script whose job is to remove them. `i18n-add-locale-cost` said so
 *  out loud when the first draft did exactly that. */
function sourceLocales(items, rows, constName) {
  const codes = items.filter((it) => it.kind === 'entry').map((it) => it.key);
  const unknown = codes.filter((c) => !rows.some((r) => r.code === c));
  if (unknown.length > 0) {
    throw new Error(`${constName}: locale block(s) [${unknown}] are not rows in the registry`);
  }
  return codes;
}

/** The fifteen flat string shards, merged into `S` by strings.ts. Their keys
 *  share ONE namespace (that is what the merge means), so a leaf key is the
 *  catalogue key unchanged. */
export const SHARDS = [
  ['nav', 'NAV_STRINGS'],
  ['devices', 'DEVICES_STRINGS'],
  ['cloud', 'CLOUD_STRINGS'],
  ['pairing', 'PAIRING_STRINGS'],
  ['settings', 'SETTINGS_STRINGS'],
  ['timeline', 'TIMELINE_STRINGS'],
  ['search', 'SEARCH_STRINGS'],
  ['capsule', 'CAPSULE_STRINGS'],
  ['connection', 'CONNECTION_STRINGS'],
  ['sidecar', 'SIDECAR_STRINGS'],
  ['probe', 'PROBE_STRINGS'],
  ['portable', 'PORTABLE_STRINGS'],
  ['stats', 'STATS_STRINGS'],
  ['disclosure', 'DISCLOSURE_STRINGS'],
  ['update', 'UPDATE_STRINGS'],
];

/** The per-locale catalogues that are NOT part of `S`.
 *
 *  🔴 THE BRIEF FOR THIS MIGRATION NAMED ONE OF THESE (SETTINGS_MSG). There are
 *  five, and leaving four behind would have been the whole point missed: each is
 *  a `Record<UiLocale, …>`, so language #5 is a compile error in four more files
 *  — the exact cost this work exists to remove.
 *
 *  `kind: 'fn'` means the values are arrow functions (count-bearing messages
 *  whose WORD ORDER is per-locale, which is why they are functions and not
 *  fragments). They migrate the same way as strings: the value is TS source. */
export const SUB_CATALOGUES = [
  ['capsule', 'INJECT_FAIL_REASON_BY_LOCALE', 'injectFailReason', 'string'],
  ['settings', 'SETTINGS_MSG_BY_LOCALE', 'settingsMsg', 'fn'],
  ['timeline', 'TL_BATCH_MSG_BY_LOCALE', 'tlBatchMsg', 'fn'],
  ['timeline', 'TL_RETENTION_MSG_BY_LOCALE', 'tlRetentionMsg', 'fn'],
  ['timeline', 'TL_METRICS_MSG_BY_LOCALE', 'tlMetricsMsg', 'fn'],
];

// ── the parser ───────────────────────────────────────────────────────────────

/** Skip whitespace and both comment forms from `i`, collecting the comments
 *  verbatim (they are the half of this catalogue worth more than the strings).
 *  Returns `{ i, comments }` where each comment keeps its own source text. */
export function skipTrivia(src, i, comments = null) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      if (comments) comments.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i);
      if (close === -1) throw new Error('unterminated block comment');
      if (comments) comments.push(src.slice(i, close + 2));
      i = close + 2;
      continue;
    }
    return { i, comments };
  }
}

/** Walk one string/template literal whose opening quote is at `i`; return the
 *  index just past the closing quote. Handles escapes and, for templates,
 *  `${…}` holes containing nested strings and braces. */
export function readStringLiteral(src, i) {
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') throw new Error(`not a string at ${i}`);
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = readBalanced(src, j + 1, '{', '}');
      continue;
    }
    if (c === quote) return j + 1;
    if (c === '\n' && quote !== '`') throw new Error(`newline inside a ${quote}-quoted string at ${i}`);
    j += 1;
  }
  throw new Error(`unterminated string at ${i}`);
}

/** `i` indexes the opening bracket; returns the index just past its match. */
function readBalanced(src, i, open, close) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      j = readStringLiteral(src, j);
      continue;
    }
    if (src.startsWith('//', j)) {
      const nl = src.indexOf('\n', j);
      j = nl === -1 ? src.length : nl;
      continue;
    }
    if (src.startsWith('/*', j)) {
      const e = src.indexOf('*/', j);
      j = e === -1 ? src.length : e + 2;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  throw new Error(`unbalanced ${open} at ${i}`);
}

/** Read one value expression starting at `i`, stopping at the `,` or `}` that
 *  closes it at depth 0. Returns the index just past the value. */
export function readValue(src, i) {
  let j = i;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      j = readStringLiteral(src, j);
      continue;
    }
    if (src.startsWith('//', j)) {
      const nl = src.indexOf('\n', j);
      j = nl === -1 ? src.length : nl;
      continue;
    }
    if (src.startsWith('/*', j)) {
      const e = src.indexOf('*/', j);
      j = e === -1 ? src.length : e + 2;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      j = readBalanced(src, j, c, c === '(' ? ')' : c === '[' ? ']' : '}');
      continue;
    }
    if (depth === 0 && (c === ',' || c === '}')) return j;
    j += 1;
  }
  throw new Error(`unterminated value at ${i}`);
}

/** Parse an object literal body. `open` indexes its `{`.
 *  Items are, in source order: `{kind:'comment', text}` and
 *  `{kind:'entry', key, value, valueStart, valueEnd}`. */
export function parseObject(src, open) {
  if (src[open] !== '{') throw new Error(`parseObject: no { at ${open}`);
  const items = [];
  let i = open + 1;
  for (;;) {
    const comments = [];
    ({ i } = skipTrivia(src, i, comments));
    for (const text of comments) items.push({ kind: 'comment', text });
    if (i >= src.length) throw new Error('parseObject: ran off the end');
    if (src[i] === '}') return { items, end: i + 1 };
    // key: bare identifier, or a quoted one ('zh-CN').
    let key;
    if (src[i] === "'" || src[i] === '"') {
      const e = readStringLiteral(src, i);
      key = src.slice(i + 1, e - 1);
      i = e;
    } else {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i, i + 80));
      if (!m) throw new Error(`parseObject: not a key at ${i}: ${JSON.stringify(src.slice(i, i + 40))}`);
      key = m[0];
      i += m[0].length;
    }
    ({ i } = skipTrivia(src, i));
    if (src[i] === '(') throw new Error(`parseObject: method shorthand is not supported (key ${key})`);
    if (src[i] !== ':') throw new Error(`parseObject: expected ':' after ${key} at ${i}`);
    i = skipTrivia(src, i + 1).i;
    const valueStart = i;
    const valueEnd = readValue(src, i);
    items.push({
      kind: 'entry',
      key,
      value: src.slice(valueStart, valueEnd).replace(/\s+$/, ''),
      valueStart,
      valueEnd,
    });
    i = skipTrivia(src, valueEnd).i;
    if (src[i] === ',') i += 1;
    else if (src[i] !== '}') throw new Error(`parseObject: expected ',' or '}' after ${key} at ${i}`);
  }
}

/** Locate `<const> = {` and parse the object. Returns the object plus the span
 *  of the whole `export const NAME … };` statement, which the migrator replaces. */
export function parseCatalogue(src, constName) {
  const decl = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b[^=]*=\\s*\\{`);
  const m = decl.exec(src);
  if (!m) throw new Error(`${constName} not found`);
  const open = m.index + m[0].length - 1;
  const { items, end } = parseObject(src, open);
  // Past the closing brace: an optional `as const` and the terminating `;`.
  let after = skipTrivia(src, end).i;
  if (src.startsWith('as const', after)) after = skipTrivia(src, after + 'as const'.length).i;
  if (src[after] !== ';') throw new Error(`${constName}: no ';' after the object literal`);
  return { items, start: m.index, end: after + 1, declStart: m.index };
}

// ── classification ───────────────────────────────────────────────────────────

/** `TIMELINE_STRINGS['zh-CN'].st_injected` / `TIMELINE_STRINGS.en.st_injected`
 *  — the same-source references (IJ-02 §C-3). Returns `{catalogue, locale, key}`. */
export function asCrossReference(value) {
  const m = /^([A-Z][A-Z0-9_]*)(?:\['([^']+)'\]|\.([A-Za-z][A-Za-z0-9]*))\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(
    value,
  );
  if (!m) return null;
  return { catalogue: m[1], locale: m[2] ?? m[3], key: m[4] };
}

/** A value that is exactly one quoted string literal. */
export function isPlainLiteral(value) {
  if (value.length < 2) return false;
  const q = value[0];
  if (q !== "'" && q !== '"') return false;
  let end;
  try {
    end = readStringLiteral(value, 0);
  } catch {
    return false;
  }
  return end === value.length;
}

/** The generated function catalogue evaluates its arrows in a module that binds
 *  `CATALOGUE` (the full per-locale string table). Three arms in the source read
 *  a sibling string through the shard object instead — `TIMELINE_STRINGS
 *  ['zh-CN'].copied`, the anti-façade wiring that keeps 「已复制」 spelled once —
 *  and that name does not exist in the generated module. Rewritten here, with
 *  the LOCALE KEPT VERBATIM: an arm belongs to its language, and rewriting
 *  `['zh-CN']` to "whatever locale this arm ends up in" would change behaviour
 *  in the one case that matters (an inherited English arm must keep reading the
 *  English prefix, so the whole sentence stays one language).
 *
 *  Anything else that names a shard catalogue is REFUSED rather than passed
 *  through to fail as an undefined identifier inside a generated file. */
export function normaliseFunctionSource(text, leafKey) {
  const out = text.replaceAll(/\bTIMELINE_STRINGS(?=\[|\.)/g, 'CATALOGUE');
  const stray = /\b([A-Z][A-Z0-9_]*_STRINGS)\b/.exec(out);
  if (stray) throw new Error(`${leafKey}: function value references ${stray[1]}, which the generated module does not bind`);
  return out;
}

/** A multi-line value becomes an array of lines with the common indentation
 *  stripped, so the JSON stays readable and the generator can re-indent it.
 *  A single-line value stays a string. */
export function toJsonValue(value) {
  if (!value.includes('\n')) return value;
  const lines = value.split('\n');
  const rest = lines.slice(1).filter((l) => l.trim() !== '');
  const indent = Math.min(...rest.map((l) => l.length - l.trimStart().length));
  return [lines[0], ...lines.slice(1).map((l) => l.slice(indent))];
}

// ── extraction ───────────────────────────────────────────────────────────────

function shardSource(file) {
  return readFileSync(path.join(SHARD_DIR, `${file}.ts`), 'utf8');
}

/**
 * Read every catalogue out of the shard sources.
 * @returns {{leaves: object[], byLocale: Map<string, Map<string, unknown>>, problems: string[]}}
 */
export function extractAll() {
  const rows = readUiLocales();
  const problems = [];
  const leaves = [];
  const byLocale = new Map();
  /** Fixed by the FIRST catalogue read; every later one must match it. */
  let locales = null;
  const seen = new Set();

  const takeCatalogue = (file, constName, ns, kind, shard) => {
    const src = shardSource(file);
    const cat = parseCatalogue(src, constName);
    const localeBlocks = cat.items.filter((it) => it.kind === 'entry');
    const codes = sourceLocales(cat.items, rows, constName);
    if (locales === null) {
      locales = codes;
      for (const c of codes) byLocale.set(c, new Map());
    } else if (codes.join(',') !== locales.join(',')) {
      // Membership AND order: the blocks are read positionally nowhere, but two
      // catalogues disagreeing about which languages exist means the source is
      // half-migrated, and guessing which half is right is how a language goes
      // missing from one surface only.
      problems.push(`${constName}: locale blocks [${codes}] differ from [${locales}]`);
      return;
    }
    for (const block of localeBlocks) {
      const locale = block.key;
      const inner = parseObject(src, src.indexOf('{', block.valueStart));
      for (const item of inner.items) {
        if (item.kind !== 'entry') continue;
        const leafKey = ns ? `${ns}.${item.key}` : item.key;
        if (locale === locales[0] || !seen.has(leafKey)) {
          if (!seen.has(leafKey)) {
            seen.add(leafKey);
            leaves.push({ key: leafKey, shard, kind, name: item.key });
          }
        }
        const ref = asCrossReference(item.value);
        if (ref) {
          if (ref.locale !== locale) {
            problems.push(`${leafKey}[${locale}] references ${ref.catalogue}[${ref.locale}] — cross-locale reference`);
            continue;
          }
          const leaf = leaves.find((l) => l.key === leafKey);
          if (leaf.sameAs && leaf.sameAs !== ref.key) {
            problems.push(`${leafKey}: two different aliases (${leaf.sameAs} / ${ref.key})`);
          }
          leaf.sameAs = ref.key;
          continue;
        }
        if (kind === 'string' && !isPlainLiteral(item.value)) {
          problems.push(`${leafKey}[${locale}] is neither a literal nor a same-source reference: ${item.value.slice(0, 60)}`);
          continue;
        }
        let value = item.value;
        if (kind === 'fn') {
          const params = /^\(([^)]*)\)\s*=>/.exec(value);
          if (!params) {
            problems.push(`${leafKey}[${locale}] is not a parenthesised arrow function: ${value.slice(0, 60)}`);
            continue;
          }
          const names = params[1].split(',').map((p) => p.trim()).filter(Boolean);
          const leaf = leaves.find((l) => l.key === leafKey);
          if (leaf.params && leaf.params.join(',') !== names.join(',')) {
            // Parameter NAMES are part of the leaf's contract, not of a
            // translation: they are what the sentence interpolates. Two arms
            // disagreeing means one of them renamed a hole, and a generated
            // class would then interpolate a variable that is not there.
            problems.push(`${leafKey}[${locale}] parameters [${names}] differ from [${leaf.params}]`);
            continue;
          }
          leaf.params = names;
          try {
            value = normaliseFunctionSource(value, `${leafKey}[${locale}]`);
          } catch (err) {
            problems.push(String(err.message));
            continue;
          }
        }
        byLocale.get(locale).set(leafKey, toJsonValue(value));
      }
    }
  };

  for (const [file, constName] of SHARDS) takeCatalogue(file, constName, null, 'string', file);
  for (const [file, constName, ns, kind] of SUB_CATALOGUES) {
    takeCatalogue(file, constName, ns, kind, file);
  }

  // An aliased leaf carries no value of its own IN ANY LANGUAGE: that is what
  // 「引用，不是抄一份」 means, and it is now structural rather than a grep. If a
  // value survived here, the alias is a copy and the guard was wrong.
  for (const leaf of leaves.filter((l) => l.sameAs)) {
    for (const [locale, table] of byLocale) {
      if (table.has(leaf.key)) problems.push(`${leaf.key}[${locale}] is aliased AND carries a value`);
    }
  }
  return { leaves, byLocale, locales, problems };
}

function orderedStrings(leaves, table) {
  const out = {};
  for (const leaf of leaves) {
    if (table.has(leaf.key)) out[leaf.key] = table.get(leaf.key);
  }
  return out;
}

function main() {
  const rows = readUiLocales();
  const { leaves, byLocale, locales, problems } = extractAll();
  if (problems.length > 0) {
    console.error(`extract-desktop-strings: ${problems.length} problem(s) — refusing to write:`);
    for (const p of problems) console.error(`  ! ${p}`);
    process.exit(1);
  }

  const aliased = leaves.filter((l) => l.sameAs);
  console.log(`shards           : ${SHARDS.length} + ${SUB_CATALOGUES.length} sub-catalogue(s)`);
  console.log(`leaves           : ${leaves.length}  (${leaves.filter((l) => l.kind === 'fn').length} function, ${aliased.length} same-source alias)`);
  for (const l of locales) {
    console.log(`  ${l.padEnd(6)} ${String(byLocale.get(l).size).padStart(4)} value(s)`);
  }

  if (process.argv.includes('--stdout')) return;

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    path.join(DATA_DIR, 'leaves.json'),
    `${JSON.stringify({ leaves }, null, 2)}\n`,
  );
  for (const code of locales) {
    const spec = rows.find((r) => r.code === code);
    if (!spec) throw new Error(`extract: source locale ${code} has no registry row`);
    writeFileSync(
      path.join(DATA_DIR, `${code}.json`),
      `${JSON.stringify({ locale: code, strings: orderedStrings(leaves, byLocale.get(code)) }, null, 2)}\n`,
    );
  }
  console.log(`wrote            : ${DATA_REL}/leaves.json + ${locales.length} locale file(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

void existsSync;
