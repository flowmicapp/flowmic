// scripts/i18n/snapshot-rendered.mjs
//
// The safety net for the P1 migration (architecture doc §8): prove that after
// moving 688 strings out of their call sites, **every member still returns the
// same sentence in every language**.
//
// 🔴 WHAT THIS PROVES, AND WHAT IT DOES NOT — the distinction is the whole point.
// The generated locale classes copy their values VERBATIM from the pre-migration
// source text (migrate-mobile.mjs `armSource` re-uses the original literal
// pieces, quote style and escapes included), so "the strings are unchanged" is
// true by construction and proving it again would be measuring the copy against
// itself. The risk that is REAL lies elsewhere:
//   · a member could end up wired to the WRONG leaf (a key-derivation slip
//     silently swaps two sentences, and both still exist so nothing looks
//     missing — this is the failure that would ship);
//   · the span-based shard rewrite could damage the logic around a call
//     (a `switch` arm returning the wrong branch).
// Both are invisible to a diff of the string tables and invisible to a compile.
// They are only visible by CALLING each member and comparing what comes out.
//
// So this emits a Dart test that walks every public getter on AppStrings for
// every locale and compares against a golden captured BEFORE the migration.
// Run it before, migrate, run the test after: any swapped or damaged member
// fails by name.
//
// ⚠️ Getters only. 81 of the 531 members take arguments and cannot be walked
// without inventing inputs; inventing them would produce a golden that asserts
// our guesses rather than the product. Those are covered by the existing 2,489
// tests, which DO call them with real inputs. Stated here rather than left for
// someone to discover the gap later.
//
// Usage:
//   node scripts/i18n/snapshot-rendered.mjs --emit-test   # writes the Dart harness
//   (then: cd apps/mobile && flutter test test/i18n_migration_golden_test.dart)

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './extract-mobile-strings.mjs';

const SHARDS = path.join(ROOT, 'apps', 'mobile', 'lib', 'src', 'settings', 'strings');
const GOLDEN = path.join(ROOT, '.local', 'i18n', 'rendered-golden.json');
const TEST = path.join(ROOT, 'apps', 'mobile', 'test', 'i18n_migration_golden_test.dart');

/** Public, zero-argument, non-nullable getters — the walkable surface. */
function publicGetters() {
  const names = new Set();
  for (const f of readdirSync(SHARDS).filter((f) => f.endsWith('.dart'))) {
    const src = readFileSync(path.join(SHARDS, f), 'utf8');
    for (const m of src.matchAll(/^ {2}String get ([a-z][A-Za-z0-9_]*)\s*(?:=>|\{)/gm)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

function emitTest(getters) {
  const rows = getters.map((g) => `    '${g}': (AppStrings s) => s.${g},`).join('\n');
  return `// GENERATED — DO NOT EDIT BY HAND.
// Source: node scripts/i18n/snapshot-rendered.mjs --emit-test
//
// 🔴 THE MIGRATION GOLDEN (architecture doc §8).
// Captures what every public getter returns, in every locale, so the 0.2.67
// catalogue migration can be proved to have changed NOTHING a user reads.
//
// Why a golden and not "the tests still pass": the failure this is aimed at is a
// member wired to the WRONG leaf. Both sentences still exist, nothing is missing,
// the app compiles, and the existing suite only notices if it happens to assert
// that exact string. A swap would otherwise ship — in one language, on one
// screen, discoverable only by a user who reads that language.
//
// FIRST RUN writes the golden; later runs compare against it. Delete the golden
// only when you intend to re-baseline, and never in the same commit as a
// migration — a re-baseline in that commit asserts nothing at all.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';

// final, not const: a tear-off closure is not a constant expression.
final Map<String, String Function(AppStrings)> _getters =
    <String, String Function(AppStrings)>{
${rows}
  };

void main() {
  test('🔴 every public string getter renders exactly what it rendered before the migration', () {
    final File file = File('.local/i18n/rendered-golden.json');
    final Map<String, Map<String, String>> now = <String, Map<String, String>>{};
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final Map<String, String> one = <String, String>{};
      _getters.forEach((String name, String Function(AppStrings) read) {
        one[name] = read(s);
      });
      now[locale.name] = one;
    }

    if (!file.existsSync()) {
      file.parent.createSync(recursive: true);
      file.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(now));
      // Fail loudly rather than passing: a run that only WROTE the baseline has
      // compared nothing, and a green tick there would be the most misleading
      // possible result.
      fail('golden written (\${now.values.first.length} getters x \${now.length} locales) — re-run to compare');
    }

    final Map<String, dynamic> golden =
        jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final List<String> drift = <String>[];
    golden.forEach((String locale, dynamic entries) {
      final Map<String, dynamic> want = entries as Map<String, dynamic>;
      final Map<String, String>? got = now[locale];
      if (got == null) {
        // A locale in the golden that no longer exists. Not necessarily wrong
        // (a language can be retired) but never silent.
        drift.add('locale \$locale disappeared');
        return;
      }
      want.forEach((String name, dynamic value) {
        if (!got.containsKey(name)) {
          drift.add('\$locale.\$name: getter gone');
        } else if (got[name] != value) {
          drift.add('\$locale.\$name:\\n    was: \$value\\n    now: \${got[name]}');
        }
      });
    });
    expect(drift, isEmpty, reason: '\${drift.length} string(s) changed:\\n\${drift.join('\\n')}');
  });
}
`;
}

function main() {
  const getters = publicGetters();
  console.log(`walkable public getters: ${getters.length}`);
  if (!process.argv.includes('--emit-test')) {
    console.log('(pass --emit-test to write the Dart harness)');
    return;
  }
  mkdirSync(path.dirname(GOLDEN), { recursive: true });
  writeFileSync(TEST, emitTest(getters));
  console.log(`wrote: ${path.relative(ROOT, TEST)}`);
  console.log('next : cd apps/mobile && flutter test test/i18n_migration_golden_test.dart  (writes the golden, fails on purpose)');
  console.log('then : run it again — it must pass BEFORE you migrate.');
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('snapshot-rendered.mjs')) main();
