#!/usr/bin/env node
// Codegen for the MOBILE FLUTTER surface of the UI-locale architecture
// (docs/strategy/2026-08-14-locale-expansion-architecture.md §4.1).
//
//   logic + key contract  ->  apps/mobile/lib/src/settings/strings/*.dart  (hand-written)
//   which languages exist ->  packages/protocol/src/locales.ts             (the registry)
//   the strings           ->  i18n/mobile/<code>.json                      (data, one file per language)
//   the leaf contract     ->  i18n/mobile/leaves.json                      (names + arity)
//   the Dart              ->  lib/src/settings/l10n/*.g.dart               (THIS script's output)
//
// Adding language N+1 to this surface = a registry row + one JSON file + a run.
// No shard, no call site, no picker, no test.
//
// 🔴 THE VALUES IN THE JSON ARE DART SOURCE, NOT PLAIN TEXT.
// `"historyRows": "'共 $n 条'"` carries its own quotes, its own escapes and its
// own interpolation. That is deliberate and it is the only faithful choice: the
// catalogue's strings contain `$`-holes that must survive, and re-encoding a
// decoded string is exactly how a migration silently re-quotes something wrong.
// A value may also be an ARRAY of literals — Dart concatenates adjacent string
// literals, which is how the 1,000-character paragraphs in this catalogue are
// wrapped, and the wrapping is preserved rather than reflowed.
//
// 🔴 ENGLISH IS THE BASE AND A MISSING TRANSLATION FALLS BACK TO IT
// (owner 2026-08-14, 17 册 §0-bis). Structurally, not by lookup:
// `AppStringsEn` implements every leaf, every other locale `extends
// AppStringsEn` and overrides only what it has. A missing translation therefore
// CANNOT become an empty string or a bare key, and there is no runtime table
// that can miss.
//
// ⚠️ WHAT THAT RULING TOOK AWAY, AND WHAT REPLACES IT. The old contract made a
// missing translation a COMPILE error, and the one thing it bought was that we
// could never be wrong about how complete a language was. Falling back silently
// to the USER must not mean falling back silently to US — so this script MEASURES
// coverage per language, prints it, and writes it to i18n/mobile/coverage.json
// for a gate to read. Fallback is a declared degradation, never an unnoticed one.
// The base locale itself is still checked the hard way: a leaf missing from
// en.json is refused here, before anything is emitted.
//
// Usage:
//   node scripts/i18n/gen-mobile-dart.mjs            # write
//   node scripts/i18n/gen-mobile-dart.mjs --check    # verify, write nothing
//   node scripts/i18n/gen-mobile-dart.mjs --check --skip-missing
//        # ...but treat "not generated on this machine yet" as OK. The output is
//        # gitignored (`*.g.dart`), so on a clean checkout it legitimately does
//        # not exist until `make -C apps/mobile gen` runs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readUiLocales, baseCode, REPO_ROOT, REGISTRY_REL } from './locale-registry.mjs';

const DATA_REL = 'i18n/mobile';
const OUT_DIR_REL = 'apps/mobile/lib/src/settings/l10n';
const LEAVES_REL = `${OUT_DIR_REL}/leaves.g.dart`;
const LOCALES_REL = `${OUT_DIR_REL}/app_strings_locales.g.dart`;
const COVERAGE_REL = `${DATA_REL}/coverage.json`;
const SELF_REL = 'scripts/i18n/gen-mobile-dart.mjs';

const DATA_DIR = join(REPO_ROOT, DATA_REL);

const BANNER = (source) =>
  `// GENERATED — DO NOT EDIT BY HAND.\n// Source: ${source}\n// Regenerate: node ${SELF_REL}\n`;

/** `en` -> `AppStringsEn`, `zhTw` -> `AppStringsZhTw`. Derived from the
 *  registry's `dart` field, which is where the Dart spelling of a locale is
 *  decided once (Dart enum members cannot contain a hyphen). */
export function className(dart) {
  return `AppStrings${dart.charAt(0).toUpperCase()}${dart.slice(1)}`;
}

/** One catalogue value -> the Dart source that follows `=>`. An array is a run
 *  of adjacent literals; Dart concatenates them, and keeping the run means the
 *  original line wrapping is preserved instead of reflowed into one huge line. */
function valueSource(value) {
  return Array.isArray(value) ? value.join('\n      ') : value;
}

function signature(leaf, params) {
  return params.length === 0
    ? `String get ${leaf}`
    : `String ${leaf}(${params.map((p) => `Object? ${p}`).join(', ')})`;
}

export function emitLeaves(leaves) {
  const lines = leaves.map((l) => `  ${signature(l.leaf, l.params)};`);
  return (
    `${BANNER(`${DATA_REL}/leaves.json`)}` +
    '//\n' +
    '// One leaf per translated string, and nothing else: no logic, no comments.\n' +
    '// The REASONING for each string stays where it always was — beside the member\n' +
    '// that uses it, in ../strings/*.dart. That is the half of this catalogue worth\n' +
    "// more than the strings themselves (「PCID 在所有语言里都不翻译，因为…」), and\n" +
    '// moving it here would have made it nine times harder to read for exactly zero\n' +
    '// benefit.\n' +
    '//\n' +
    '// 🔴 A LEAF THAT TAKES PARAMETERS TAKES THEM BECAUSE THE SENTENCE INTERPOLATES\n' +
    '// SOMETHING THAT ONLY EXISTS AT THE CALL SITE — a local or a parameter of the\n' +
    '// member that renders it. They are `Object?` on purpose and not out of\n' +
    '// laziness: Dart interpolation calls `toString()`, so `Object?` is exactly as\n' +
    '// much type as the value is used with, and claiming more (`String`, `int`)\n' +
    '// would be a claim this generator cannot check.\n' +
    '\n' +
    "part of '../app_strings.dart';\n\n" +
    '/// The leaf contract every language implements.\n' +
    '///\n' +
    '/// PUBLIC only because the 19 shard mixins declare `on AppStringsLeaves`, and\n' +
    '/// a private type in a public `on` clause is 19 analyzer complaints. The part\n' +
    '/// that actually had to stay private did: every member below is\n' +
    "/// library-private, so the catalogue's internals are reachable from the\n" +
    '/// generated locale classes (same library, `part of`) and from nowhere else.\n' +
    'abstract class AppStringsLeaves {\n' +
    '  /// Const so that `AppStrings.forLocale` can stay const, so that every\n' +
    '  /// generated locale class can stay a compile-time constant. Without it the\n' +
    '  /// whole chain loses `const` and the analyzer says so 60 call sites away.\n' +
    '  const AppStringsLeaves();\n\n' +
    `${lines.join('\n')}\n}\n`
  );
}

export function emitLocales(leaves, base, others) {
  const body = (spec, strings, isBase) =>
    leaves
      .filter((l) => strings[l.key] !== undefined)
      .map(
        (l) =>
          `  @override\n  ${signature(l.leaf, l.params)} => ${valueSource(strings[l.key])};`,
      )
      .join('\n') || `  // ${isBase ? '' : 'no translations yet — every leaf inherits English'}`;

  const chunks = [];
  chunks.push(
    `class ${className(base.spec.dart)} extends AppStrings {\n` +
      `  const ${className(base.spec.dart)}() : super.forLocale(AppLocale.${base.spec.dart});\n\n` +
      '  /// Every other locale class extends this one, so it needs a way to say\n' +
      '  /// which language it is. Not public API: the only callers are the\n' +
      '  /// generated subclasses below.\n' +
      `  const ${className(base.spec.dart)}.forLocale(AppLocale locale)\n` +
      '      : super.forLocale(locale);\n\n' +
      `${body(base.spec, base.strings, true)}\n}\n`,
  );
  for (const o of others) {
    chunks.push(
      `/// ${o.spec.code} (${o.spec.endonym}) — ${o.provided}/${leaves.length} leaves translated;\n` +
        `/// the rest inherit ${base.spec.code} by construction (owner 2026-08-14, 17 册 §0-bis).\n` +
        `class ${className(o.spec.dart)} extends ${className(base.spec.dart)} {\n` +
        `  const ${className(o.spec.dart)}() : super.forLocale(AppLocale.${o.spec.dart});\n\n` +
        `${body(o.spec, o.strings, false)}\n}\n`,
    );
  }

  const arms = [base, ...others]
    .map((l) => `  AppLocale.${l.spec.dart} => const ${className(l.spec.dart)}(),`)
    .join('\n');

  return (
    `${BANNER(`${DATA_REL}/*.json + ${REGISTRY_REL}`)}` +
    '//\n' +
    '// 🔴 ONE CLASS PER LANGUAGE, AND EVERY ONE OF THEM EXTENDS ENGLISH.\n' +
    '// owner 2026-08-14: 「默认的语种是英文」 — a string a language has not\n' +
    '// translated yet renders in English. Inheritance is how that is guaranteed\n' +
    '// rather than hoped for: an un-overridden leaf resolves to the English\n' +
    '// implementation at compile time, so it cannot come out empty, cannot come\n' +
    '// out as a bare key, and needs no runtime lookup that could miss.\n' +
    '//\n' +
    '// Per-language completeness is measured, not assumed — see\n' +
    `// ${COVERAGE_REL} and the header of ${SELF_REL}.\n` +
    '\n' +
    "part of '../app_strings.dart';\n\n" +
    `${chunks.join('\n')}\n` +
    '/// The one switch over languages in the whole app. Generated, so adding a\n' +
    '/// language adds an arm here without anyone editing it — which is the entire\n' +
    '/// point of the exercise (architecture doc §2).\n' +
    `AppStrings _appStringsFor(AppLocale locale) => switch (locale) {\n${arms}\n};\n`
  );
}

/** Read the leaf contract and every locale's data, and refuse anything that
 *  would produce a catalogue we cannot vouch for. */
export function loadCatalogue() {
  const leavesPath = join(DATA_DIR, 'leaves.json');
  if (!existsSync(leavesPath)) {
    throw new Error(`gen-mobile-dart: ${DATA_REL}/leaves.json is missing — run the P1 migration first`);
  }
  const leaves = JSON.parse(readFileSync(leavesPath, 'utf8')).leaves;
  const rows = readUiLocales();
  const base = baseCode(undefined, rows);

  const all = rows.map((spec) => {
    const p = join(DATA_DIR, `${spec.code}.json`);
    const strings = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).strings : null;
    const provided = strings === null ? 0 : leaves.filter((l) => strings[l.key] !== undefined).length;
    return { spec, strings, provided, present: strings !== null };
  });

  const baseEntry = all.find((l) => l.spec.code === base);
  if (!baseEntry || !baseEntry.present) {
    throw new Error(`gen-mobile-dart: the base locale '${base}' has no data file in ${DATA_REL}`);
  }
  // 🔴 The base locale is the one that may not be partial. Everything else
  // inherits from it, so a hole here is a hole in every language at once — and
  // it would surface as an unimplemented abstract member, i.e. a wall of
  // compile errors in a file nobody reads. Named here instead.
  const holes = leaves.filter((l) => baseEntry.strings[l.key] === undefined);
  if (holes.length > 0) {
    throw new Error(
      `gen-mobile-dart: the base locale '${base}' is missing ${holes.length} leaf value(s), ` +
        `starting with ${holes.slice(0, 5).map((h) => h.key).join(', ')}`,
    );
  }
  const strays = Object.keys(baseEntry.strings).filter((k) => !leaves.some((l) => l.key === k));
  if (strays.length > 0) {
    throw new Error(
      `gen-mobile-dart: ${base}.json has ${strays.length} key(s) with no leaf in leaves.json: ` +
        strays.slice(0, 5).join(', '),
    );
  }

  return { leaves, base: baseEntry, all };
}

export function coverageReport(leaves, all) {
  return {
    total: leaves.length,
    generated: `${SELF_REL}`,
    locales: all.map((l) => ({
      code: l.spec.code,
      endonym: l.spec.endonym,
      translated: l.provided,
      inheritsBase: leaves.length - l.provided,
      percent: Math.round((l.provided / leaves.length) * 1000) / 10,
      // A language with no data file at all is not "0% translated and shipping"
      // — it is not in the app. Two different facts; the report says which.
      inApp: l.present,
    })),
  };
}

function artefacts() {
  const { leaves, base, all } = loadCatalogue();
  const others = all.filter((l) => l.present && l.spec.code !== base.spec.code);
  return {
    leaves,
    all,
    files: [
      [LEAVES_REL, emitLeaves(leaves)],
      [LOCALES_REL, emitLocales(leaves, base, others)],
      [COVERAGE_REL, `${JSON.stringify(coverageReport(leaves, all), null, 2)}\n`],
    ],
  };
}

function printCoverage(report) {
  console.log(`leaf contract    : ${report.total} strings`);
  for (const l of report.locales) {
    const bar = l.inApp
      ? `${String(l.translated).padStart(4)}/${report.total}  ${String(l.percent).padStart(5)}%`
      : '   —          not in the app yet (no data file)';
    console.log(`  ${l.code.padEnd(6)} ${l.endonym.padEnd(10)} ${bar}`);
  }
}

function main() {
  const check = process.argv.includes('--check');
  const skipMissing = process.argv.includes('--skip-missing');
  const { leaves, all, files } = artefacts();

  if (check) {
    const drift = [];
    for (const [rel, want] of files) {
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) {
        if (skipMissing) continue;
        drift.push(`${rel} does not exist (run \`make -C apps/mobile gen\`)`);
        continue;
      }
      if (readFileSync(abs, 'utf8') !== want) drift.push(`${rel} is stale`);
    }
    if (drift.length > 0) {
      console.error(`gen-mobile-dart --check FAILED: ${drift.join('; ')}`);
      process.exit(1);
    }
    console.log(`gen-mobile-dart --check OK (${leaves.length} leaves, ${all.filter((l) => l.present).length} language(s))`);
    return;
  }

  for (const [rel, text] of files) {
    const abs = join(REPO_ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  printCoverage(coverageReport(leaves, all));
  console.log(`wrote            : ${LEAVES_REL}, ${LOCALES_REL}, ${COVERAGE_REL}`);
}

if (process.argv[1] && process.argv[1].endsWith('gen-mobile-dart.mjs')) main();
