#!/usr/bin/env node
// scripts/i18n/gen-i18n-web.mjs
//
// Build `packages/i18n-web/src/generated/` — the nine-locale SUBSET catalogue the
// browser clients render — from this monorepo's own i18n source.
//
// SPEC-REF:
//   i18n/web/subset.json                                        (the selection)
//   i18n/mobile/<locale>.json                                   (the sentences)
//   packages/protocol/src/locales.ts                            (the language list)
//   docs/strategy/2026-09-05-web-client-subproject-design.md §6, §10
//   docs/decisions/2026-09-06-owner-web-client-rulings-repo-protocol-domains.md (W-8)
//
// 🔴 WHY DERIVED AND NOT COPIED. The web client is a second surface for wording
// this repo has already ruled on twice — 15-DELIVERY-CHANNELS §2.0 forbids reusing
// a word across the delivery/injection segments, and 0.2.53 was a whole round spent
// on one truncated verdict sentence. A hand-kept web copy of those strings is a
// second answer to the same question, and the copy is the one nobody re-reads when
// the ruling changes. So the selection is hand-maintained (which keys) and the
// values never are (what they say).
//
// 🔴 WHAT IT REFUSES RATHER THAN GUESSES. Every refusal below is a case where
// producing *something* would be worse than stopping:
//   · a selected key missing from any of the nine locales — falling back to
//     English would ship an English sentence into eight catalogues with nothing
//     saying so, and coverage is 100% today (i18n/mobile/coverage.json), so an
//     absence means the selection is wrong, not the translation;
//   · locales that disagree about WHICH values a sentence interpolates — the same
//     refusal, and for the same reason, as scripts/i18n/interpolation.mjs's
//     `planEntry`: unioning them renders fine today and drops a value the day a
//     translator's arm is the one being read;
//   · a literal brace in the text — `{name}` is this package's placeholder
//     syntax, so a literal `{` would be indistinguishable from a hole;
//   · a Dart raw string (`r'…'`) or an escape this file does not decode — the
//     mobile catalogue is Dart source text, and a half-decoded escape is a
//     wrong sentence that compiles.
//
// 🔴 WRAPPED LITERALS. Some catalogue values are a JSON array of two or more
// adjacent Dart string literals — Dart's ordinary way of wrapping one long
// sentence. Dart parses EACH piece as its own literal and concatenates the
// resulting strings with NO separator. `convert()` does the same: it never
// feeds the array to `splitLiteral` (that helper accepts one literal), and it
// never glues the source interiors into one fake literal (that would re-parse
// an escape or a `$` that sits on the seam). Interpolation holes belong to the
// whole sentence; they cannot span the quote boundary in valid Dart, so each
// piece is converted independently and the texts are concatenated in order.
//
// Regenerate:   node scripts/i18n/gen-i18n-web.mjs        (also via `pnpm i18n:gen`)
// Verify only:  node scripts/i18n/gen-i18n-web.mjs --check
//               (exit 1, NAMES the drifted file, writes nothing — this is the mode
//                verify/lint/i18n-generated-fresh.mjs runs, because a generator's
//                own --check proves nothing until something calls it)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readUiLocales, defaultCode, baseCode, REGISTRY_REL } from './locale-registry.mjs';
import { splitLiteral, paramNameFor } from './interpolation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SUBSET_REL = 'i18n/web/subset.json';
const OUT_REL = 'packages/i18n-web/src/generated';
const OUT_DIR = join(ROOT, OUT_REL);
const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error(`[i18n-web] ${message}`);
  process.exit(1);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

/** Decode ONE Dart text run into the characters it actually renders.
 *
 *  splitLiteral keeps text parts as SOURCE BYTES (its own doc says so, and that
 *  is what lets the Dart generator round-trip). A `\'` handed to a browser
 *  verbatim renders a backslash, so the escapes have to be resolved here — and
 *  an escape this function does not know is a REFUSAL, not a passthrough: the
 *  quiet version of this bug is one wrong character in one language. */
function decodeDartText(text, where) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = text[i + 1];
    i += 1;
    switch (n) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': case "'": case '"': case '$': out += n; break;
      case 'u': {
        if (text[i + 1] === '{') {
          const close = text.indexOf('}', i + 1);
          if (close === -1) fail(`${where}: unterminated \\u{…} escape`);
          out += String.fromCodePoint(Number.parseInt(text.slice(i + 2, close), 16));
          i = close;
          break;
        }
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(`${where}: malformed \\u escape`);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        fail(
          `${where}: unsupported Dart escape \\${n}. This generator decodes escapes ` +
            'rather than passing them through, so an unknown one is refused instead of ' +
            'rendering as a stray backslash in one language.',
        );
    }
  }
  return out;
}

/** One Dart string literal -> `{ text, params }` in this package's `{name}` syntax. */
function convertOne(literal, where) {
  let split;
  try {
    split = splitLiteral(literal);
  } catch (e) {
    return fail(`${where}: ${e.message}`);
  }
  if (split.raw) {
    fail(`${where}: Dart raw string (r'…'). Refused rather than half-decoded.`);
  }
  let text = '';
  const params = [];
  for (const part of split.parts) {
    if (part.kind === 'text') {
      const decoded = decodeDartText(part.text, where);
      if (/[{}]/.test(decoded)) {
        fail(`${where}: literal brace in the sentence — it would be indistinguishable from a {placeholder}.`);
      }
      text += decoded;
      continue;
    }
    const name = paramNameFor(part.expr);
    if (!params.includes(name)) params.push(name);
    text += `{${name}}`;
  }
  return { text, params };
}

/** One catalogue entry -> `{ text, params }`.
 *
 *  A JSON array is Dart adjacent-literal wrapping: each piece is a complete
 *  literal, converted on its own, then concatenated in source order with no
 *  separator and no reordering. `splitLiteral` is left untouched — it still
 *  accepts exactly one literal, which is what every other caller already
 *  hands it. */
export function convert(value, where) {
  const pieces = Array.isArray(value) ? value : [value];
  if (pieces.length === 0) {
    fail(`${where}: empty adjacent-literal array`);
  }
  let text = '';
  const params = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const pieceWhere = pieces.length === 1 ? where : `${where}[${i}]`;
    const one = convertOne(pieces[i], pieceWhere);
    text += one.text;
    for (const p of one.params) {
      if (!params.includes(p)) params.push(p);
    }
  }
  return { text, params };
}

function runGenerator() {
// ── read the selection ───────────────────────────────────────────────────────
const subset = JSON.parse(readFileSync(join(ROOT, SUBSET_REL), 'utf8'));
const KEYS = [];
for (const group of subset.groups ?? []) {
  if (!group.id || !group.why || !Array.isArray(group.keys)) {
    fail(`${SUBSET_REL}: every group needs id, why and keys — got ${JSON.stringify(group).slice(0, 80)}`);
  }
  for (const k of group.keys) {
    if (KEYS.includes(k)) fail(`${SUBSET_REL}: '${k}' is listed twice (second time in group '${group.id}')`);
    KEYS.push(k);
  }
}
if (KEYS.length === 0) fail(`${SUBSET_REL}: the selection is empty`);

// ── read the languages ───────────────────────────────────────────────────────
const rows = readUiLocales();
const DEFAULT_LOCALE = defaultCode(undefined, rows);
const BASE_LOCALE = baseCode(undefined, rows);
const baseRow = rows.find((r) => r.code === BASE_LOCALE);
if (!baseRow) fail(`${REGISTRY_REL}: BASE_UI_LOCALE '${BASE_LOCALE}' has no row`);

// ── read the sentences ───────────────────────────────────────────────────────
const catalogues = new Map();
for (const row of rows) {
  const path = join(ROOT, 'i18n', 'mobile', `${row.code}.json`);
  if (!existsSync(path)) {
    fail(
      `i18n/mobile/${row.code}.json does not exist, but '${row.code}' is a UI_LOCALES row. ` +
        'Either the language was added to the registry without its data file, or this ' +
        'generator is reading the wrong directory — both are defects, neither is a fallback.',
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed.strings) fail(`i18n/mobile/${row.code}.json has no \`strings\` object`);
  catalogues.set(row.code, parsed.strings);
}

// ── convert, and cross-check every locale against the base one ───────────────
const messages = new Map(rows.map((r) => [r.code, new Map()]));
const paramsByKey = new Map();
for (const key of KEYS) {
  for (const row of rows) {
    const literal = catalogues.get(row.code)[key];
    if (literal === undefined) {
      fail(
        `'${key}' is selected in ${SUBSET_REL} but missing from i18n/mobile/${row.code}.json. ` +
          'Not substituted with the base locale: a silent English sentence inside a ' +
          'nine-language catalogue is the failure this package exists to make impossible.',
      );
    }
    const { text, params } = convert(literal, `${row.code}#${key}`);
    messages.get(row.code).set(key, text);
    if (row.code === BASE_LOCALE) paramsByKey.set(key, params);
  }
  // Declared order comes from the base locale (owner 2026-08-14: copy is
  // authored in English); every other locale must use the SAME SET, in any word
  // order it likes. Disagreement is refused — same rule, same reason, as
  // interpolation.mjs's planEntry.
  const expected = [...(paramsByKey.get(key) ?? [])].sort().join(',');
  for (const row of rows) {
    const mine = [...new Set([...(messages.get(row.code).get(key).matchAll(/\{([^}]+)\}/g))].map((m) => m[1]))]
      .sort()
      .join(',');
    if (mine !== expected) {
      fail(
        `'${key}': ${row.code} interpolates {${mine || '—'}} while ${BASE_LOCALE} interpolates ` +
          `{${expected || '—'}}. Refused rather than unioned — the union renders today and ` +
          'drops a value the day that locale is the one on screen.',
      );
    }
  }
}

// ── emit ─────────────────────────────────────────────────────────────────────
const BANNER = (from) =>
  `// GENERATED by scripts/i18n/gen-i18n-web.mjs — DO NOT EDIT.\n` +
  `// Source: ${from}\n` +
  `// Regenerate with \`pnpm i18n:gen\`; \`pnpm verify:lint\` (i18n-generated-fresh)\n` +
  `// fails when this file and its source disagree.\n`;

const ident = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const lit = (s) => JSON.stringify(s);

const files = new Map();

files.set(
  'locales.ts',
  BANNER(REGISTRY_REL) +
    '\n/** The languages this catalogue carries — the product registry, not a subset of it. */\n' +
    'export const WEB_LOCALES = [\n' +
    rows.map((r) => `  { code: ${lit(r.code)}, endonym: ${lit(r.endonym)}, script: ${lit(r.script)} },`).join('\n') +
    '\n] as const;\n\n' +
    'export type WebLocaleCode = (typeof WEB_LOCALES)[number][\'code\'];\n\n' +
    '/** What the first frame renders before anyone has chosen. */\n' +
    `export const DEFAULT_WEB_LOCALE: WebLocaleCode = ${lit(DEFAULT_LOCALE)};\n\n` +
    '/** What a missing translation falls back to (owner 2026-08-29: English is the\n' +
    ' *  auxiliary language). Deliberately a SECOND constant: 「第一帧渲染哪一种」 and\n' +
    ' *  「缺译回落到哪一种」 are two questions. */\n' +
    `export const BASE_WEB_LOCALE: WebLocaleCode = ${lit(BASE_LOCALE)};\n`,
);

for (const row of rows) {
  const body = KEYS.map((k) => `  ${JSON.stringify(k)}: ${lit(messages.get(row.code).get(k))},`).join('\n');
  const name = ident(row.code);
  const isBase = row.code === BASE_LOCALE;
  const head = BANNER(`${SUBSET_REL} x i18n/mobile/${row.code}.json`);
  files.set(
    `messages/${row.code}.ts`,
    isBase
      ? `${head}\n/** The base catalogue. Its keys ARE the key type: every other locale is\n` +
          ` *  annotated against it, so a language missing a key is a compile error rather\n` +
          ` *  than a blank on screen. */\nexport const ${name} = {\n${body}\n} as const;\n`
      : `${head}\nimport type { WebMessages } from '../keys.js';\n\n` +
          `export const ${name}: WebMessages = {\n${body}\n};\n`,
  );
}

files.set(
  'keys.ts',
  BANNER(SUBSET_REL) +
    `\nimport { ${ident(BASE_LOCALE)} } from './messages/${BASE_LOCALE}.js';\n\n` +
    '/** Every key the web clients may render. Derived from the base catalogue, so\n' +
    ' *  it cannot drift from what is actually shipped. */\n' +
    `export type WebMessageKey = keyof typeof ${ident(BASE_LOCALE)};\n\n` +
    'export type WebMessages = Readonly<Record<WebMessageKey, string>>;\n\n' +
    '/** The placeholders each sentence takes, in the base locale\'s declared order.\n' +
    ' *\n' +
    ' *  `as const satisfies` and not an annotation: the annotation would widen every\n' +
    ' *  tuple to `string[]` and `formatMessage` could then no longer demand the RIGHT\n' +
    ' *  parameter names at the call site — while `satisfies` still makes a missing key\n' +
    ' *  a compile error. Both halves are load-bearing. */\n' +
    'export const MESSAGE_PARAMS = {\n' +
    KEYS.map((k) => `  ${JSON.stringify(k)}: [${(paramsByKey.get(k) ?? []).map(lit).join(', ')}],`).join('\n') +
    '\n} as const satisfies Record<WebMessageKey, readonly string[]>;\n',
);

files.set(
  'catalogue.ts',
  BANNER(`${SUBSET_REL} x i18n/mobile/*.json`) +
    '\n' +
    rows.map((r) => `import { ${ident(r.code)} } from './messages/${r.code}.js';`).join('\n') +
    "\nimport type { WebLocaleCode } from './locales.js';\n" +
    "import type { WebMessages } from './keys.js';\n\n" +
    '/** Annotated, not inferred: `Record<WebLocaleCode, …>` is what makes switching\n' +
    ' *  a language on in the registry without its catalogue a compile error. */\n' +
    'export const MESSAGES: Readonly<Record<WebLocaleCode, WebMessages>> = {\n' +
    rows.map((r) => `  ${JSON.stringify(r.code)}: ${ident(r.code)},`).join('\n') +
    '\n};\n',
);

// ── write or check ───────────────────────────────────────────────────────────
function existingFiles() {
  const out = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(OUT_DIR, '');
  return out;
}

const stale = [];
for (const [rel, content] of files) {
  const abs = join(OUT_DIR, rel);
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  if (current === content) continue;
  if (CHECK) {
    stale.push(`${OUT_REL}/${rel} (${current === null ? 'missing' : 'differs'})`);
    continue;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

// A file the generator no longer produces is drift in the direction nobody
// looks: it keeps compiling and keeps exporting a key that has left the subset.
for (const rel of existingFiles()) {
  if (files.has(rel)) continue;
  if (CHECK) stale.push(`${OUT_REL}/${rel} (no longer generated)`);
  else rmSync(join(OUT_DIR, rel));
}

if (CHECK) {
  if (stale.length > 0) {
    console.error(`[i18n-web] stale generated output:\n  ${stale.join('\n  ')}`);
    console.error('[i18n-web] run `pnpm i18n:gen` and commit the result.');
    process.exit(1);
  }
  console.log(`[i18n-web] up to date — ${KEYS.length} key(s) x ${rows.length} locale(s)`);
} else {
  console.log(
    `[i18n-web] wrote ${files.size} file(s) to ${relative(ROOT, OUT_DIR).replace(/\\/g, '/')} ` +
      `— ${KEYS.length} key(s) x ${rows.length} locale(s)`,
  );
}
}

if (isDirectRun()) runGenerator();
