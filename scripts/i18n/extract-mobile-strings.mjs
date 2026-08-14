// scripts/i18n/extract-mobile-strings.mjs
//
// Extract every `_t(...)` call site in the Flutter catalogue into a machine
// worksheet, so the 0.2.67 locale expansion (4 -> 9 languages, docs/rebuild/
// 17-UI-LOCALE-GLOSSARY.md) can be produced and reviewed as DATA rather than as
// 686 hand edits.
//
// 🔴 WHY A PARSER AND NOT A REGEX. A Dart string literal can contain `)`, `'`,
// `$`-interpolation with nested braces and calls, adjacent-literal concatenation
// across lines, and `\'` escapes — every one of those appears in this catalogue.
// A regex that "mostly works" would silently mis-slice a handful of entries out
// of 686, and the damage would be invisible: the file still compiles, one string
// is quietly wrong in one language. So this walks the source with a tiny state
// machine and REFUSES to guess: anything it cannot parse exactly is reported and
// counted, never approximated.
//
// The extractor is deliberately paired with a verifier (verify-roundtrip.mjs):
// the only property that makes the reinsertion safe is that re-extracting after
// the rewrite yields byte-identical zh/en/ja/ko values. This file is one half of
// that pair; neither half is trustworthy alone.
//
// Usage:
//   node scripts/i18n/extract-mobile-strings.mjs            # writes the worksheet
//   node scripts/i18n/extract-mobile-strings.mjs --stdout   # prints a summary

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const SHARD_DIR = path.join(ROOT, 'apps', 'mobile', 'lib', 'src', 'settings', 'strings');
const OUT = path.join(ROOT, '.local', 'i18n', 'mobile-catalogue.json');

/** The four arms every call site carries today, in source order. */
export const CURRENT_ARMS = ['zh', 'en', 'ja', 'ko'];

/** Walk a Dart string literal starting at `i` (which must index the opening
 *  quote). Returns {raw, end} where `raw` INCLUDES both quotes and `end` is the
 *  index just past the closing quote.
 *
 *  Handles: single/double quotes, backslash escapes, and `${...}` interpolation
 *  with nested braces (the catalogue really does contain
 *  `'${count} 条'` and `'${s.foo(bar)}'`). Raw strings (r'...') are handled by
 *  the caller noting the prefix; inside a raw string a backslash is literal, so
 *  escape handling is switched off. */
export function readDartString(src, i) {
  let raw = false;
  if (src[i] === 'r') {
    raw = true;
    i += 1;
  }
  const quote = src[i];
  if (quote !== "'" && quote !== '"') return null;
  // Triple-quoted strings exist in Dart; the catalogue has none today, but
  // guessing at one would corrupt it, so detect and refuse rather than assume.
  if (src.slice(i, i + 3) === quote.repeat(3)) return { unsupported: 'triple-quoted' };
  const start = raw ? i - 1 : i;
  let j = i + 1;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (!raw && c === '\\') {
      j += 2;
      continue;
    }
    if (c === '$' && src[j + 1] === '{') {
      depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        else if (src[j] === "'" || src[j] === '"') {
          const inner = readDartString(src, j);
          if (!inner || inner.unsupported) return { unsupported: 'nested-string' };
          j = inner.end;
          continue;
        }
        j += 1;
      }
      continue;
    }
    if (c === quote) return { text: src.slice(start, j + 1), end: j + 1 };
    if (c === '\n') return { unsupported: 'newline-in-single-quoted' };
    j += 1;
  }
  return { unsupported: 'unterminated' };
}

/** Skip whitespace and both Dart comment forms, starting at `i`. */
function skipTrivia(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    return i;
  }
}

/** Parse ONE `_t(` call whose `(` is at `open`. Returns the four arms with their
 *  exact source spans, or an `unsupported` marker. Adjacent string literals
 *  (Dart implicit concatenation, used for the long paragraphs in this
 *  catalogue) are collected as a list of pieces rather than flattened, so a
 *  rewrite can put the new arms beside them without reflowing anything. */
export function parseCall(src, open) {
  let i = open + 1;
  const args = {};
  for (;;) {
    i = skipTrivia(src, i);
    if (src[i] === ')') return { args, end: i + 1 };
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(src.slice(i, i + 40));
    if (!m) return { unsupported: 'non-named-argument' };
    const name = m[1];
    i = skipTrivia(src, i + m[0].length);
    const pieces = [];
    const valueStart = i;
    // An arm may legitimately be an EXPRESSION rather than a literal. The real
    // case in this catalogue is `en: englishLabel` in `packLabel` — the English
    // answer is the protocol's own SSOT label, deliberately not a translation we
    // invented (settings_strings.dart:168-171). Classify it instead of calling
    // it a parse failure: it is a different KIND of entry, and the migration has
    // to treat it differently (the value is computed, so it cannot move into a
    // per-locale data file as a string).
    const ident = /^([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/.exec(src.slice(i, i + 64));
    if (ident) {
      args[name] = { expression: ident[1], start: valueStart, end: i + ident[1].length };
      i = skipTrivia(src, i + ident[1].length);
      if (src[i] === ',') i += 1;
      else if (src[i] !== ')') return { unsupported: 'unexpected-token-after-expression' };
      continue;
    }
    for (;;) {
      const lit = readDartString(src, i);
      if (!lit) return { unsupported: 'value-not-a-string' };
      if (lit.unsupported) return { unsupported: lit.unsupported };
      pieces.push(lit.text);
      const after = skipTrivia(src, lit.end);
      if (src[after] === "'" || src[after] === '"' || (src[after] === 'r' && /['"]/.test(src[after + 1] ?? ''))) {
        i = after; // adjacent literal — Dart concatenates these
        continue;
      }
      i = after;
      break;
    }
    args[name] = { pieces, start: valueStart, end: i };
    i = skipTrivia(src, i);
    if (src[i] === ',') i += 1;
    else if (src[i] !== ')') return { unsupported: 'unexpected-token-after-value' };
  }
}

export function extractFile(file) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  const entries = [];
  const problems = [];
  const re = /_t\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Skip the abstract/concrete DECLARATIONS (`String _t(`), which are the
    // signature, not a call.
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/String\s+$/.test(before)) continue;
    const parsed = parseCall(src, m.index + 2);
    const line = src.slice(0, m.index).split('\n').length;
    if (parsed.unsupported) {
      problems.push({ file: rel, line, reason: parsed.unsupported });
      continue;
    }
    const names = Object.keys(parsed.args);
    const missing = CURRENT_ARMS.filter((a) => !names.includes(a));
    if (missing.length > 0 || names.length !== CURRENT_ARMS.length) {
      problems.push({ file: rel, line, reason: `arms=${names.join('+')}` });
      continue;
    }
    const computed = CURRENT_ARMS.filter((a) => parsed.args[a].expression !== undefined);
    entries.push({
      id: `${rel}#${line}`,
      file: rel,
      line,
      callStart: m.index,
      callEnd: parsed.end,
      // Arms that are computed rather than literal are carried as-is; the
      // migration cannot move them into a per-locale data file (see parseCall).
      computedArms: computed.length > 0 ? computed : undefined,
      arms: Object.fromEntries(
        CURRENT_ARMS.map((a) => [
          a,
          parsed.args[a].expression !== undefined
            ? { expression: parsed.args[a].expression }
            : parsed.args[a].pieces,
        ]),
      ),
    });
  }
  return { entries, problems };
}

export function extractAll() {
  const files = readdirSync(SHARD_DIR)
    .filter((f) => f.endsWith('.dart'))
    .map((f) => path.join(SHARD_DIR, f));
  const entries = [];
  const problems = [];
  for (const f of files) {
    const r = extractFile(f);
    entries.push(...r.entries);
    problems.push(...r.problems);
  }
  return { entries, problems, files: files.length };
}

function main() {
  const { entries, problems, files } = extractAll();
  const literal = entries.filter((e) => !e.computedArms);
  const computed = entries.filter((e) => e.computedArms);
  const chars = literal.reduce((n, e) => n + e.arms.en.join('').length, 0);
  console.log(`shards           : ${files}`);
  console.log(`call sites parsed: ${entries.length}  (${literal.length} literal + ${computed.length} with a computed arm)`);
  console.log(`unparsed         : ${problems.length}`);
  for (const e of computed) console.log(`  ~ ${e.file}:${e.line} computed arm(s): ${e.computedArms.join(',')}`);
  for (const p of problems.slice(0, 20)) console.log(`  ! ${p.file}:${p.line} ${p.reason}`);
  console.log(`en source chars  : ${chars}`);
  if (!process.argv.includes('--stdout')) {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify({ entries, problems }, null, 2)}\n`);
    console.log(`worksheet        : ${path.relative(ROOT, OUT)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
