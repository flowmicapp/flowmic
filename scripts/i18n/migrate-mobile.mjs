// scripts/i18n/migrate-mobile.mjs
//
// P1 of the locale-expansion plan (architecture doc §4.1, §8): move the Flutter
// catalogue from "four string literals at every call site" to "one leaf per
// string, implemented once per locale".
//
// 🔴 THIS SCRIPT RUNS ONCE. It reads `_t(zh:…, en:…, ja:…, ko:…)` call sites,
// which is exactly what it destroys. After it has run there is nothing left for
// it to read — the repeatable half is scripts/i18n/gen-mobile-dart.mjs, which
// regenerates the Dart from the data files this one extracts. Keep it anyway:
// it is the only written account of how those data files were produced, and the
// next surface (desktop TS, P2) has the same shape.
//
// WHAT IT TOUCHES, AND WHAT IT DELIBERATELY DOES NOT.
// Every `_t(...)` EXPRESSION is replaced in place by a reference to a generated
// leaf. Nothing else in the shard files moves: every member keeps its name, its
// position, its logic and — the part that actually matters — its comments, which
// are where this catalogue's real value lives. 「PCID 在所有语言里都不翻译，因为…」
// is worth more than the four strings under it, and it stays beside the member
// that answers to it rather than being dragged into a data file.
//
// 🔴 WHAT ATTEMPT #1 GOT WRONG (architecture doc §8-bis). 86 of the 690 strings
// interpolate something that only exists at the call site. A leaf is therefore
// a getter OR a method; scripts/i18n/interpolation.mjs decides which, and its
// header explains why parameters are matched by expression TEXT and not by
// position, and why whole `${…}` units are hoisted rather than the identifiers
// inside them.
//
// 🔴 WHAT IT REFUSES. A call whose arms interpolate DIFFERENT expressions is
// left alone, printed, and counted. Those are the sites where the expression
// carries language-specific content — an English plural rule, a localised
// fallback, a localised list separator — and unioning them would move
// translated text OUT of the locale layer, which is the opposite of the point.
// The residual is honest and it is loud: `_t`'s switch stays exhaustive, so the
// day a fifth language is added those sites fail to compile by name.
//
// Usage:
//   node scripts/i18n/migrate-mobile.mjs --dry     # report only, writes nothing
//   node scripts/i18n/migrate-mobile.mjs --apply   # rewrite shards + emit data + Dart

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { deriveKeys } from './derive-keys.mjs';
import { ROOT, CURRENT_ARMS } from './extract-mobile-strings.mjs';
import { readUiLocales, baseCode } from './locale-registry.mjs';
import { planEntry } from './interpolation.mjs';

const MOBILE = path.join(ROOT, 'apps', 'mobile', 'lib', 'src', 'settings');
const DATA_DIR = path.join(ROOT, 'i18n', 'mobile');
const LEAF_PREFIX = '_lf';

/** `pcidLabel` -> `_lfPcidLabel`. Library-private on purpose: every generated
 *  locale class is a `part of` the same library, so private leaves are reachable
 *  there and nowhere else — the catalogue's internals do not become API. */
export function leafName(key) {
  return LEAF_PREFIX + key.charAt(0).toUpperCase() + key.slice(1);
}

/** The `dart` name of the arm whose word order fixes the parameter order. */
function baseArm(rows) {
  const code = baseCode(undefined, rows);
  const row = rows.find((r) => r.code === code);
  if (!CURRENT_ARMS.includes(row.dart)) {
    throw new Error(`migrate-mobile: base locale ${code} has no arm in the current call sites`);
  }
  return row.dart;
}

export function buildPlan(rows = readUiLocales()) {
  const { entries, problems } = deriveKeys();
  if (problems.length) {
    throw new Error(`refusing to migrate: ${problems.length} call site(s) did not parse`);
  }
  const base = baseArm(rows);
  const migrate = [];
  const refused = [];
  const seen = new Set();
  for (const e of entries) {
    const plan = planEntry(e, CURRENT_ARMS, base);
    if (plan.kind === 'skip') {
      refused.push({ entry: e, plan });
      continue;
    }
    const leaf = leafName(e.key);
    if (seen.has(leaf)) throw new Error(`refusing to migrate: duplicate leaf ${leaf}`);
    seen.add(leaf);
    migrate.push({ entry: e, plan, leaf });
  }
  return { migrate, refused, base };
}

/** The call-site expression that replaces one `_t(...)`. */
function callSource(item) {
  if (item.plan.kind === 'getter') return item.leaf;
  return `${item.leaf}(${item.plan.params.map((p) => p.expr).join(', ')})`;
}

/** Does this source still contain a `_t(` CALL (as opposed to the declaration)? */
function hasRemainingTCall(src) {
  const re = /_t\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!/String\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) return true;
  }
  return false;
}

/** Rewrite one shard.
 *
 *  Replacements are applied BACK TO FRONT so that every span offset stays valid
 *  — editing forwards would shift every later offset by the length delta, which
 *  is the classic way this kind of rewrite corrupts a file silently. */
export function rewriteShard(src, itemsForFile) {
  let out = src;
  const ordered = [...itemsForFile].sort((a, b) => b.entry.callStart - a.entry.callStart);
  for (const it of ordered) {
    out = out.slice(0, it.entry.callStart) + callSource(it) + out.slice(it.entry.callEnd);
  }
  if (!hasRemainingTCall(out)) {
    // The per-shard abstract `_t` declaration goes with its last caller. Matched
    // conservatively: the exact four-named-parameter form this catalogue uses,
    // nothing looser. A shard that still has a refused call site keeps it.
    out = out.replace(
      /\n\s*String _t\(\{\s*required String zh,\s*required String en,\s*required String ja,\s*required String ko,\s*\}\);\n/,
      '\n',
    );
  }
  if (itemsForFile.length > 0) out = addOnClause(out);
  return out;
}

/** `mixin FooStrings {` -> `mixin FooStrings on AppStringsLeaves {` so the shard can see
 *  the generated leaves. `on` (rather than re-declaring them per shard) keeps
 *  every leaf declared exactly once. */
export function addOnClause(src) {
  return src.replace(/^mixin\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm, (m, name) =>
    m.includes(' on ') ? m : `mixin ${name} on AppStringsLeaves {`,
  );
}

/** One arm's catalogue value: a string for a single literal, an array for a run
 *  of adjacent literals (which Dart concatenates). Either way the ORIGINAL
 *  source text is reused — quote style, escapes and wrapping included. Copying
 *  the source rather than re-encoding a decoded string is what makes the
 *  migration golden meaningful: nothing is re-quoted, so nothing can be
 *  re-quoted WRONG. */
function armValue(item, arm) {
  const raw = item.plan.kind === 'getter' ? item.entry.arms[arm] : item.plan.bodies[arm];
  if (typeof raw === 'string') return raw;
  return raw.length === 1 ? raw[0] : raw;
}

function writeData(migrate, rows) {
  mkdirSync(DATA_DIR, { recursive: true });
  const sorted = [...migrate].sort((a, b) => a.leaf.localeCompare(b.leaf));
  const leaves = sorted.map((it) => ({
    key: it.entry.key,
    leaf: it.leaf,
    params: it.plan.kind === 'getter' ? [] : it.plan.params.map((p) => p.name),
  }));
  writeFileSync(
    path.join(DATA_DIR, 'leaves.json'),
    `${JSON.stringify({ leaves }, null, 2)}\n`,
  );
  const written = [];
  for (const spec of rows) {
    if (!CURRENT_ARMS.includes(spec.dart)) continue; // no data for it yet — that is P4
    const strings = {};
    for (const it of sorted) strings[it.entry.key] = armValue(it, spec.dart);
    writeFileSync(
      path.join(DATA_DIR, `${spec.code}.json`),
      `${JSON.stringify({ locale: spec.code, strings }, null, 2)}\n`,
    );
    written.push(spec.code);
  }
  return { leaves, written };
}

/** Replace exactly once, and shout if the anchor was not there. A rewrite that
 *  silently does nothing is the worst outcome available here: the file still
 *  compiles in some half-migrated shape and the failure surfaces hundreds of
 *  errors away from its cause. */
function replaceOnce(src, pattern, replacement, what) {
  const before = src;
  const out = src.replace(pattern, replacement);
  if (out === before) throw new Error(`migrate-mobile: anchor not found while ${what}`);
  return out;
}

/** Rewire app_strings.dart: the class becomes abstract (each language is a
 *  concrete subclass), `of()` delegates to a GENERATED switch so a new language
 *  never touches this file, and `_t` stays for the refused call sites — with a
 *  comment that no longer claims something that stopped being true. */
export function rewireAppStrings(refusedCount) {
  const p = path.join(MOBILE, 'app_strings.dart');
  let src = readFileSync(p, 'utf8');
  const NL = '\n';

  src = replaceOnce(
    src,
    /part 'strings\/update_strings\.dart';/,
    (m) =>
      [
        m,
        '',
        '// ── 0.2.67 the generated locale layer (architecture doc §4.1) ────────────────',
        '// Two parts, and it stays two parts however many languages there are: the leaf',
        '// contract, and every language that implements it. Adding a language adds a',
        '// class inside the second file, never a line in this one — that is the whole',
        '// property this migration exists to buy (§2), and a `part` directive added by',
        '// hand per language would have quietly given it back.',
        "part 'l10n/leaves.g.dart';",
        "part 'l10n/app_strings_locales.g.dart';",
      ].join(NL),
    'inserting the generated part directives',
  );

  src = replaceOnce(
    src,
    /\nclass AppStrings\n    with\n/,
    `${NL}abstract class AppStrings extends AppStringsLeaves${NL}    with${NL}`,
    'making AppStrings abstract',
  );

  src = replaceOnce(
    src,
    /  const AppStrings\(this\.locale\);\r?\n  final AppLocale locale;\r?\n\r?\n  static AppStrings of\(AppLocale locale\) => AppStrings\(locale\);/,
    [
      '  const AppStrings.forLocale(this.locale);',
      '',
      '  /// Kept so the existing `AppStrings(locale)` call sites read exactly as they',
      '  /// did before. Deliberately NOT const — a const factory needs one redirect',
      '  /// target and this one has to choose between the languages — which is why the',
      '  /// handful of `const AppStrings(...)` sites lost their `const`.',
      '  factory AppStrings(AppLocale locale) => AppStrings.of(locale);',
      '  final AppLocale locale;',
      '',
      '  /// The one place a language is turned into a catalogue. The switch itself is',
      '  /// GENERATED (l10n/app_strings_locales.g.dart) from',
      '  /// packages/protocol/src/locales.ts, so a new language never edits this file.',
      '  static AppStrings of(AppLocale locale) => _appStringsFor(locale);',
    ].join(NL),
    'rewiring the constructor and of()',
  );

  src = replaceOnce(
    src,
    /\r?\n  \/\/ All four languages REQUIRED at every call site[\s\S]*?\r?\n  @override\r?\n  String _t\(\{/,
    [
      '',
      `  // 🔴 THE RESIDUE: ${refusedCount} call sites still spell their four languages out here,`,
      '  // and they are the only ones left. Every other string in this catalogue is a',
      '  // generated leaf (l10n/), which is why this helper reads as an exception now',
      '  // rather than as the mechanism.',
      '  //',
      '  // They were refused ON PURPOSE, and by ONE rule with no judgement call in it:',
      '  // a call whose arms interpolate DIFFERENT expressions is left alone. Twelve',
      '  // sites meet that description and they are two different shapes:',
      '  //   · SIX carry language-specific CONTENT inside the expression — an English',
      "  //     plural rule (`n == 1 ? '' : 'es'`), a localised fallback",
      "  //     (`outcome.detail ?? '未知原因'`), a localised list separator",
      "  //     (`reasons.join('、')`), whole localised sentences inside a conditional",
      '  //     (`portableReadme`). Hoisting those into a shared parameter list would',
      '  //     have moved translated text OUT of the locale layer, and the next',
      '  //     language could then never supply its own plural or its own separator',
      '  //     without editing Dart. For these six, refusing is the right answer.',
      '  //   · SIX are `packLabel`, where the `en` arm is not a translation at all but',
      "  //     the protocol's own SSOT label handed in by the caller. Unioning those",
      '  //     would in fact have been safe. They are refused anyway, because the',
      '  //     alternative is a generator that decides case by case which',
      '  //     disagreements are benign — and a rule that has exceptions is a rule',
      '  //     whose next exception nobody reviews.',
      '  //',
      '  // ⚠️ The switch stays exhaustive with no default, so this is not a quiet debt:',
      '  // the day AppLocale gains a fifth member, these sites fail to compile, by name,',
      '  // and whoever adds that language has to give each of them a real answer.',
      '  // (Everything else falls back to English by construction — 17 册 §0-bis.)',
      '  @override',
      '  String _t({',
    ].join(NL),
    'rewriting the _t contract comment',
  );

  writeFileSync(p, src);
}

function main() {
  const apply = process.argv.includes('--apply');
  const rows = readUiLocales();
  const { migrate, refused, base } = buildPlan(rows);

  const getters = migrate.filter((m) => m.plan.kind === 'getter');
  const methods = migrate.filter((m) => m.plan.kind === 'method');
  console.log(`call sites       : ${migrate.length + refused.length}`);
  console.log(`  -> getter leaf : ${getters.length}`);
  console.log(`  -> method leaf : ${methods.length}  (${methods.reduce((n, m) => n + m.plan.params.length, 0)} parameters)`);
  console.log(`  -> refused     : ${refused.length}`);
  console.log(`base arm (order) : ${base}`);
  for (const r of refused) {
    console.log(`  ! ${r.entry.file}:${r.entry.line}  ${r.entry.key} — ${r.plan.reason}`);
    for (const d of r.plan.detail) console.log(`      ${d}`);
  }
  if (!apply) {
    console.log('(dry run — nothing written; pass --apply to write)');
    return;
  }

  const byFile = new Map();
  for (const it of migrate) {
    if (!byFile.has(it.entry.file)) byFile.set(it.entry.file, []);
    byFile.get(it.entry.file).push(it);
  }
  for (const [rel, group] of byFile) {
    const abs = path.join(ROOT, rel);
    writeFileSync(abs, rewriteShard(readFileSync(abs, 'utf8'), group));
  }
  const { leaves, written } = writeData(migrate, rows);
  rewireAppStrings(refused.length);
  console.log(`shards rewritten : ${byFile.size}`);
  console.log(`data written     : i18n/mobile/leaves.json (${leaves.length}) + ${written.join(', ')}`);
  console.log('next             : node scripts/i18n/gen-mobile-dart.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('migrate-mobile.mjs')) main();
