#!/usr/bin/env node
// Codegen for the DESKTOP WEBVIEW surface of the UI-locale architecture
// (docs/strategy/2026-08-14-locale-expansion-architecture.md §4.2).
//
// WHAT PROBLEM THIS SOLVES. Before it, adding one UI language to the webview
// meant: a fifth per-locale block in each of 15 shards, a fifth block in each of
// 5 sub-catalogues, a row in `S_BY_LOCALE`, a member in `UI_LOCALES`, and two
// hand-written `LANG_LABEL` maps — 588 units per language by the §1 measurement.
// Now:
//
//   logic + key contract  ->  apps/desktop/src/lib/strings/*.ts   (hand-written)
//   which languages exist ->  packages/protocol/src/locales.ts    (the registry)
//   the strings           ->  i18n/desktop/<code>.json            (data, one file per language)
//   the leaf contract     ->  i18n/desktop/leaves.json            (names, shard, arity)
//   the TS                ->  strings/generated/*.g.ts            (THIS script's output)
//
// Adding language N+1 to this surface = a registry row + one JSON file + a run.
// No shard, no picker, no call site, no test.
//
// 🔴 THE VALUES IN THE JSON ARE TS SOURCE, NOT PLAIN TEXT.
// `"nav_devices": "'设备'"` carries its own quotes and escapes; a function leaf
// carries a whole arrow (`"(n) => \`已选 ${n} 条\`"`). That is deliberate and it
// is the only faithful choice — re-encoding a decoded string is exactly how a
// migration silently re-quotes something wrong. A value may also be an ARRAY of
// source lines, which preserves the original wrapping instead of reflowing it.
//
// 🔴 ENGLISH IS THE BASE AND A MISSING TRANSLATION FALLS BACK TO IT
// (owner 2026-08-14, 17 册 §0-bis). Structurally, not by lookup: the base
// locale's object is emitted in full and every other locale is emitted as
// `{ ...EN, …its own overrides… }`. A missing translation therefore CANNOT come
// out empty or as a bare key, the resulting object is complete, and there is no
// runtime fallback chain that could miss. What the reader of the generated file
// sees is exactly what a language does and does not translate.
//
// ⚠️ WHAT THAT RULING TOOK AWAY, AND WHAT REPLACES IT. The old contract made a
// missing translation a compile error (`Record<UiLocale, …>` over hand-written
// blocks), and the one thing it bought was that we could never be wrong about
// how complete a language was. Falling back silently to the USER must not mean
// falling back silently to US — so this script MEASURES coverage per language,
// prints it, and writes i18n/desktop/coverage.json for a gate to read. The base
// locale itself is still checked the hard way: a leaf missing from en.json is
// refused here, before anything is emitted.
//
// Usage:
//   node scripts/i18n/gen-desktop-ts.mjs           # write
//   node scripts/i18n/gen-desktop-ts.mjs --check   # verify, write nothing

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readUiLocales, baseCode, defaultCode, REPO_ROOT, REGISTRY_REL } from './locale-registry.mjs';
// The extraction script is the one-time migration tool; these two helpers are
// the shared definition of 「a value this pipeline accepts」, so the generator
// checks with the same code the extractor produced the data with.
import { isPlainLiteral } from './extract-desktop-strings.mjs';

const DATA_REL = 'i18n/desktop';
const OUT_DIR_REL = 'apps/desktop/src/lib/strings/generated';
const SELF_REL = 'scripts/i18n/gen-desktop-ts.mjs';
const COVERAGE_REL = `${DATA_REL}/coverage.json`;
const SHARD_DIR_REL = 'apps/desktop/src/lib/strings';

const DATA_DIR = join(REPO_ROOT, DATA_REL);

/** Every namespace the leaf contract may use, and what it becomes in TS.
 *
 *  Explicit, not derived: a namespace decides an exported symbol name and a
 *  TypeScript type, and guessing either from the key prefix would mean a typo in
 *  a data file silently emits a new export nobody imports. A namespace that is
 *  not listed here stops the run. */
const NAMESPACES = [
  { ns: null, out: 'CATALOGUE', kind: 'string', file: 'catalogue', type: null, varTag: 'S' },
  {
    ns: 'injectFailReason',
    out: 'INJECT_FAIL_REASON_BY_LOCALE',
    kind: 'string',
    file: 'catalogue',
    type: 'Record<PcInjectionCode, string>',
    varTag: 'REASON',
  },
  { ns: 'settingsMsg', out: 'SETTINGS_MSG_BY_LOCALE', kind: 'fn', file: 'msg', type: 'SettingsMsg', varTag: 'SETTINGS_MSG' },
  { ns: 'tlBatchMsg', out: 'TL_BATCH_MSG_BY_LOCALE', kind: 'fn', file: 'msg', type: 'TlBatchMsg', varTag: 'TL_BATCH_MSG' },
  { ns: 'tlRetentionMsg', out: 'TL_RETENTION_MSG_BY_LOCALE', kind: 'fn', file: 'msg', type: 'TlRetentionMsg', varTag: 'TL_RETENTION_MSG' },
  { ns: 'tlMetricsMsg', out: 'TL_METRICS_MSG_BY_LOCALE', kind: 'fn', file: 'msg', type: 'TlMetricsMsg', varTag: 'TL_METRICS_MSG' },
];

const BANNER = (source) =>
  `// GENERATED — DO NOT EDIT BY HAND.\n// Source: ${source}\n// Regenerate: node ${SELF_REL}\n`;

/** `{n}` / `{detail}` occurrences, sorted and de-duplicated — the placeholder
 *  contract a translation may not change. Same shape as gen-desktop-rust.mjs. */
function placeholders(s) {
  return [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** `zh-CN` -> `ZH_CN`. The suffix of a generated const, nothing else. */
function varSuffix(code) {
  return code.replaceAll('-', '_').toUpperCase();
}

/** One catalogue value -> the TS source that follows `:`. An array is the
 *  original line wrapping, re-indented rather than reflowed. */
function valueSource(value, indent) {
  return Array.isArray(value) ? value.join(`\n${indent}`) : value;
}

// ── loading ──────────────────────────────────────────────────────────────────

/** The key contract each shard declares (`export const NAV_KEYS = [...]`).
 *
 *  🔴 READ, NOT EMITTED. The shard files are where the REASONING for each string
 *  lives — 「PCID 在所有语言里都不翻译，因为…」, 「这张绿脸与时间线的 ✓ 说的是同
 *  一个状态」 — and that half of the catalogue is worth more than the strings.
 *  Generating the lists would have thrown it away; reading them instead means
 *  the comments stay beside the key they explain, and this script can still
 *  refuse a shard whose list and whose data have drifted apart. */
function readShardKeyLists() {
  const lists = new Map();
  const files = new Set(
    JSON.parse(readFileSync(join(DATA_DIR, 'leaves.json'), 'utf8')).leaves.map((l) => l.shard),
  );
  for (const shard of files) {
    const src = readFileSync(join(REPO_ROOT, SHARD_DIR_REL, `${shard}.ts`), 'utf8');
    const m = new RegExp(`export const ([A-Z0-9_]+)_KEYS = \\[([\\s\\S]*?)\\n\\] as const;`).exec(src);
    if (!m) continue;
    const keys = [...m[2].matchAll(/^\s*'([^']+)',/gm)].map((k) => k[1]);
    lists.set(shard, keys);
  }
  return lists;
}

function loadCatalogue() {
  const leavesPath = join(DATA_DIR, 'leaves.json');
  if (!existsSync(leavesPath)) {
    throw new Error(`gen-desktop-ts: ${DATA_REL}/leaves.json is missing — run the extraction first`);
  }
  const leaves = JSON.parse(readFileSync(leavesPath, 'utf8')).leaves;
  const rows = readUiLocales();
  const base = baseCode(undefined, rows);
  const dflt = defaultCode(undefined, rows);

  for (const leaf of leaves) {
    const ns = leaf.key.includes('.') ? leaf.key.split('.')[0] : null;
    if (!NAMESPACES.some((n) => n.ns === ns)) {
      throw new Error(`gen-desktop-ts: leaf ${leaf.key} uses namespace '${ns}', which has no TS shape in NAMESPACES`);
    }
  }

  const all = rows.map((spec) => {
    const p = join(DATA_DIR, `${spec.code}.json`);
    const strings = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).strings : null;
    const translatable = leaves.filter((l) => !l.sameAs);
    const provided = strings === null ? 0 : translatable.filter((l) => strings[l.key] !== undefined).length;
    return { spec, strings, provided, present: strings !== null };
  });

  const baseEntry = all.find((l) => l.spec.code === base);
  if (!baseEntry?.present) {
    throw new Error(`gen-desktop-ts: the base locale '${base}' has no data file in ${DATA_REL}`);
  }
  if (!all.find((l) => l.spec.code === dflt)?.present) {
    // The language the FIRST FRAME renders in must exist, and it is a separate
    // question from the fallback base (the registry keeps two constants on
    // purpose). Named here rather than surfacing as a blank first screen.
    throw new Error(`gen-desktop-ts: DEFAULT_UI_LOCALE '${dflt}' has no ${DATA_REL}/${dflt}.json`);
  }
  // 🔴 The base locale is the one that may not be partial: every other language
  // inherits from it, so a hole here is a hole in all of them at once.
  const holes = leaves.filter((l) => !l.sameAs && baseEntry.strings[l.key] === undefined);
  if (holes.length > 0) {
    throw new Error(
      `gen-desktop-ts: the base locale '${base}' is missing ${holes.length} leaf value(s), ` +
        `starting with ${holes.slice(0, 5).map((h) => h.key).join(', ')}`,
    );
  }
  for (const l of all.filter((x) => x.present)) {
    const strays = Object.keys(l.strings).filter((k) => !leaves.some((leaf) => leaf.key === k));
    if (strays.length > 0) {
      throw new Error(
        `gen-desktop-ts: ${l.spec.code}.json has ${strays.length} key(s) with no leaf in leaves.json: ` +
          strays.slice(0, 5).join(', '),
      );
    }
    // An alias carries no value in ANY language — that is what 「引用，不是抄一
    // 份」 means once it is data rather than a grep (IJ-02 §C-3).
    const copied = leaves.filter((leaf) => leaf.sameAs && l.strings[leaf.key] !== undefined);
    if (copied.length > 0) {
      throw new Error(
        `gen-desktop-ts: ${l.spec.code}.json spells out ${copied.map((c) => c.key).join(', ')} — ` +
          'those leaves are same-source aliases and must not be copied',
      );
    }
  }

  // 🔴 WHAT A TRANSLATION FILE IS ALLOWED TO CONTAIN. The values are TS source,
  // which means a data file can emit code — so it is checked here, before
  // anything is written, rather than surfacing as a syntax error inside a
  // generated file nobody reads:
  //   · a plain leaf must be exactly ONE quoted literal (not an expression, not
  //     a concatenation, not an unterminated string);
  //   · its `{…}` placeholders must be the base locale's, verbatim. A
  //     translation that drops `{n}` renders a count-less sentence, and that is
  //     invisible to every other gate — the phone caught the same class once by
  //     printing a bare identifier at a user (0.2.53).
  for (const l of all.filter((x) => x.present)) {
    for (const leaf of leaves) {
      const v = l.strings[leaf.key];
      if (v === undefined) continue;
      const src = Array.isArray(v) ? v.join('\n') : v;
      if (leaf.kind === 'string' && !isPlainLiteral(src)) {
        throw new Error(
          `gen-desktop-ts: ${l.spec.code}.json ${leaf.key} is not a single string literal: ${src.slice(0, 60)}`,
        );
      }
      const want = placeholders(Array.isArray(baseEntry.strings[leaf.key]) ? baseEntry.strings[leaf.key].join('\n') : baseEntry.strings[leaf.key]);
      const got = placeholders(src);
      if (want.join(',') !== got.join(',')) {
        throw new Error(
          `gen-desktop-ts: ${l.spec.code}.json ${leaf.key} placeholder mismatch — ${base} has [${want}], this has [${got}]`,
        );
      }
    }
  }

  // Shard key lists vs. the leaf contract: one source, checked both ways.
  const shardKeys = readShardKeyLists();
  for (const [shard, keys] of shardKeys) {
    const want = leaves.filter((l) => l.shard === shard && !l.key.includes('.')).map((l) => l.key);
    const missing = want.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !want.includes(k));
    if (missing.length || extra.length) {
      throw new Error(
        `gen-desktop-ts: ${SHARD_DIR_REL}/${shard}.ts key contract drifted from ${DATA_REL}/leaves.json — ` +
          `missing [${missing.slice(0, 5)}] unexpected [${extra.slice(0, 5)}]`,
      );
    }
  }

  return { leaves, rows, base: baseEntry, dflt, all: all.filter((l) => l.present), every: all };
}

// ── emission ─────────────────────────────────────────────────────────────────

function emitLocales(rows, present, base, dflt) {
  const list = present.map((l) => `  '${l.spec.code}',`).join('\n');
  const endonyms = present
    .map((l) => `  '${l.spec.code}': '${l.spec.endonym}',`)
    .join('\n');
  const pending = rows.filter((r) => !present.some((p) => p.spec.code === r.code)).map((r) => r.code);
  return (
    `${BANNER(REGISTRY_REL)}` +
    '//\n' +
    '// 🔴 THE PICKER ORDER IS THE REGISTRY ORDER. Every language menu in the app\n' +
    '// iterates UI_LOCALES, so reordering the registry reorders what the user sees\n' +
    '// with no UI file edited. That is the point (registry header, 2026-08-14).\n' +
    '//\n' +
    '// 🔴 ENDONYMS ARE NOT TRANSLATED, so they are DATA and not catalogue keys.\n' +
    '// The four `set_lang_*` keys and the two hand-written `LANG_LABEL` maps this\n' +
    '// replaces existed only to spell 「中文 / English / 日本語 / 한국어」 four times\n' +
    '// each. A language list that renames itself is unusable to the one person who\n' +
    '// needs it — someone whose UI is in a language they cannot read is looking for\n' +
    '// their own language\'s name, not its translation.\n' +
    (pending.length
      ? `//\n// Registry rows with no ${DATA_REL}/<code>.json yet, therefore NOT offered:\n//   ${pending.join(', ')}\n// A language with no data file is not 「0% translated and shipping」 — it is not\n// in the app. Two different facts.\n`
      : `//\n// Every registry row has a data file on this surface.\n`) +
    '\n' +
    `export const UI_LOCALES = [\n${list}\n] as const;\n\n` +
    'export type UiLocale = (typeof UI_LOCALES)[number];\n\n' +
    '/** What the first frame renders before a human has ever chosen — the\n' +
    " *  registry's `DEFAULT_UI_LOCALE`. NEVER derived from the OS (red line). */\n" +
    `export const DEFAULT_LOCALE: UiLocale = '${dflt}';\n\n` +
    '/** The language a MISSING translation renders in. Deliberately a separate\n' +
    " *  constant from [DEFAULT_LOCALE]: 「缺译回落到哪一种」 and 「新装的第一帧渲染\n" +
    ' *  哪一种」 are two questions (registry, BASE_UI_LOCALE). Today they hold the\n' +
    ' *  same value; a ruling that moves one must not move the other. */\n' +
    `export const BASE_LOCALE: UiLocale = '${base}';\n\n` +
    '/** Each language\'s name IN ITSELF, from the registry. */\n' +
    `export const LOCALE_ENDONYM: Record<UiLocale, string> = {\n${endonyms}\n};\n`
  );
}

/** One namespace's per-locale objects. */
function emitNamespace(spec, leaves, base, others, indent = '    ') {
  const mine = leaves.filter((l) => (l.key.includes('.') ? l.key.split('.')[0] : null) === spec.ns);
  const owned = mine.filter((l) => !l.sameAs);
  const aliases = mine.filter((l) => l.sameAs);
  const member = (l) => l.name;
  const baseVar = `${spec.varTag}_${varSuffix(base.spec.code)}`;
  const chunks = [];

  const body = (strings, keys) =>
    keys
      .map((l) => `  ${member(l)}: ${valueSource(strings[l.key], indent)},`)
      .join('\n');

  const typeAnn = spec.type ? `: ${spec.type}` : '';
  const aliasRows = (from) =>
    aliases.map((l) => `  ${member(l)}: ${from}.${l.sameAs},`).join('\n');

  if (aliases.length > 0) {
    chunks.push(
      `const ${baseVar}_OWN = {\n${body(base.strings, owned)}\n};\n\n` +
        `const ${baseVar}${typeAnn} = {\n  ...${baseVar}_OWN,\n${aliasRows(`${baseVar}_OWN`)}\n};\n`,
    );
  } else {
    chunks.push(`const ${baseVar}${typeAnn} = {\n${body(base.strings, owned)}\n};\n`);
  }

  for (const o of others) {
    const v = `${spec.varTag}_${varSuffix(o.spec.code)}`;
    const has = owned.filter((l) => o.strings[l.key] !== undefined);
    const head =
      `// ${o.spec.code} (${o.spec.endonym}) — ${has.length}/${owned.length} translated;\n` +
      `// the rest inherit ${base.spec.code} by construction (owner 2026-08-14, 17 册 §0-bis).\n`;
    if (aliases.length > 0) {
      chunks.push(
        `${head}const ${v}_OWN = {\n  ...${baseVar}_OWN,\n${body(o.strings, has)}\n};\n\n` +
          `const ${v}${typeAnn} = {\n  ...${v}_OWN,\n${aliasRows(`${v}_OWN`)}\n};\n`,
      );
    } else {
      chunks.push(`${head}const ${v}${typeAnn} = {\n  ...${baseVar},\n${body(o.strings, has)}\n};\n`);
    }
  }

  const map = [base, ...others]
    .map((l) => `  '${l.spec.code}': ${spec.varTag}_${varSuffix(l.spec.code)},`)
    .join('\n');
  const valueType = spec.type ?? `Record<StringKey, string>`;
  const exportType =
    spec.ns === null
      ? '\n/** Every key the merged `S` catalogue has, defined by the base language.\n' +
        ' *  A key that is not here does not exist in ANY language — the base file is\n' +
        ' *  the one that may not be partial. */\n' +
        `export type StringKey = keyof typeof ${baseVar};\n`
      : '';

  return `${chunks.join('\n')}${exportType}\nexport const ${spec.out}: Record<UiLocale, ${valueType}> = {\n${map}\n};\n`;
}

function emitCatalogue(leaves, base, others) {
  const specs = NAMESPACES.filter((n) => n.file === 'catalogue');
  return (
    `${BANNER(`${DATA_REL}/*.json + ${DATA_REL}/leaves.json`)}` +
    '//\n' +
    '// 🔴 ONE OBJECT PER LANGUAGE, AND EVERY ONE OF THEM SPREADS ENGLISH.\n' +
    '// owner 2026-08-14: 「如果一个语种没有适当的翻译，就用默认语种的文本；默认语种\n' +
    '// 是英文」 — a string a language has not translated yet renders in English. The\n' +
    '// spread is how that is guaranteed rather than hoped for: the resulting object\n' +
    '// is COMPLETE, so a missing translation cannot come out as `undefined`, cannot\n' +
    '// come out as a bare key, and needs no runtime lookup that could miss. What a\n' +
    '// language does and does not translate is readable right here.\n' +
    '//\n' +
    '// 🔴 THE `_OWN` / ALIAS SPLIT IS THE SAME-SOURCE RULE, NOW STRUCTURAL (15 册 §2.5c,\n' +
    '// IJ-02 §C-3). `cap_injected` is not a string in any data file — it IS\n' +
    '// `st_injected`, per language, resolved after that language\'s overrides. The\n' +
    "// old form was a hand-written reference in capsule.ts guarded by a source grep;\n" +
    '// a translator who spelled the word twice could still drift the two apart in\n' +
    '// one language. Now there is nowhere to spell it twice.\n' +
    '//\n' +
    '// Per-language completeness is measured, not assumed — see\n' +
    `// ${COVERAGE_REL}.\n` +
    '\n' +
    "import type { PcInjectionCode } from '../contract';\n" +
    "import type { UiLocale } from './locales.g';\n\n" +
    specs.map((s) => emitNamespace(s, leaves, base, others)).join('\n')
  );
}

function emitMsg(leaves, base, others) {
  const specs = NAMESPACES.filter((n) => n.file === 'msg');
  const types = specs.map((s) => s.type).join(', ');
  return (
    `${BANNER(`${DATA_REL}/*.json + ${DATA_REL}/leaves.json`)}` +
    '//\n' +
    '// THE COUNT-BEARING MESSAGES. They are FUNCTIONS and not word fragments\n' +
    '// because WORD ORDER is a property of the language — ja/ko put the counter\n' +
    '// before the verb where zh/en put it after — so a composed sentence lives in\n' +
    '// exactly one place. The interfaces (the key contract, with the reasoning) are\n' +
    "// hand-written in ../contract.ts; only the arms are generated.\n" +
    '//\n' +
    '// Same English fallback as the string catalogue and for the same reason: an\n' +
    '// untranslated arm is inherited by spread, so it renders an English sentence\n' +
    '// rather than `undefined is not a function`.\n' +
    '//\n' +
    '// `CATALOGUE` is in scope because three arms read a sibling string through it\n' +
    "// (「已复制」 is spelled once and reused as a prefix — anti-façade wiring). The\n" +
    '// LOCALE IN THOSE READS IS DELIBERATE: an arm belongs to its language, so an\n' +
    '// inherited English arm keeps reading the English prefix and the sentence\n' +
    '// stays in one language.\n' +
    '\n' +
    `import type { ${types} } from '../contract';\n` +
    "import type { UiLocale } from './locales.g';\n" +
    "import { CATALOGUE } from './catalogue.g';\n\n" +
    specs.map((s) => emitNamespace(s, leaves, base, others)).join('\n')
  );
}

function coverageReport(leaves, every) {
  const total = leaves.filter((l) => !l.sameAs).length;
  return {
    total,
    aliases: leaves.filter((l) => l.sameAs).length,
    generated: SELF_REL,
    locales: every.map((l) => ({
      code: l.spec.code,
      endonym: l.spec.endonym,
      translated: l.provided,
      inheritsBase: total - l.provided,
      percent: Math.round((l.provided / total) * 1000) / 10,
      inApp: l.present,
    })),
  };
}

function artefacts() {
  const { leaves, rows, base, dflt, all, every } = loadCatalogue();
  const others = all.filter((l) => l.spec.code !== base.spec.code);
  return {
    leaves,
    all,
    every,
    files: [
      [`${OUT_DIR_REL}/locales.g.ts`, emitLocales(rows, all, base.spec.code, dflt)],
      [`${OUT_DIR_REL}/catalogue.g.ts`, emitCatalogue(leaves, base, others)],
      [`${OUT_DIR_REL}/msg.g.ts`, emitMsg(leaves, base, others)],
      [COVERAGE_REL, `${JSON.stringify(coverageReport(leaves, every), null, 2)}\n`],
    ],
  };
}

function printCoverage(report) {
  console.log(`leaf contract    : ${report.total} translatable + ${report.aliases} same-source alias`);
  for (const l of report.locales) {
    const bar = l.inApp
      ? `${String(l.translated).padStart(4)}/${report.total}  ${String(l.percent).padStart(5)}%`
      : '   —          not in the app yet (no data file)';
    console.log(`  ${l.code.padEnd(6)} ${l.endonym.padEnd(10)} ${bar}`);
  }
}

function main() {
  const check = process.argv.includes('--check');
  const { leaves, all, every, files } = artefacts();

  if (check) {
    const drift = [];
    for (const [rel, want] of files) {
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) drift.push(`${rel} does not exist`);
      else if (readFileSync(abs, 'utf8') !== want) drift.push(`${rel} is stale`);
    }
    if (drift.length > 0) {
      console.error(`gen-desktop-ts --check FAILED: ${drift.join('; ')} — run \`node ${SELF_REL}\``);
      process.exit(1);
    }
    console.log(`gen-desktop-ts --check OK (${leaves.length} leaves, ${all.length} language(s))`);
    return;
  }

  for (const [rel, text] of files) {
    const abs = join(REPO_ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  printCoverage(coverageReport(leaves, every));
  console.log(`wrote            : ${files.map(([r]) => r).join(', ')}`);
}

main();
