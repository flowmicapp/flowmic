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

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
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
// FIRST RUN writes the golden and SKIPS (it compared nothing, and says so);
// later runs on the same machine compare against it. Delete the golden only when
// you intend to re-baseline, and never in the same commit as a migration — a
// re-baseline in that commit asserts nothing at all.
//
// ⚠️ The baseline is machine-local (.local/ is gitignored) ⇒ in CI, and in any
// fresh clone, this test SKIPS rather than protecting anything. That is stated
// here so a green tick on a pull request is not read as "the strings were
// checked". Committing the baseline would change that; it has not been done.

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
      // A run that only WROTE the baseline has compared nothing, and a silent
      // green tick would be the most misleading possible result. It used to
      // \`fail()\` for that reason — correct on the machine this was written on,
      // where the baseline already existed and its absence meant someone had
      // deleted it.
      //
      // 🔴 CORRECTED 2026-08-14: the baseline lives under .local/, which is
      // gitignored, so it is absent on EVERY fresh clone and in every CI run.
      // Failing there means the first command CONTRIBUTING asks a contributor to
      // run is red for everyone, once, with a message about re-running — and in
      // CI, which starts clean each time, it is red FOREVER while proving
      // nothing. Measured inside an exported tree on the day this was written.
      //
      // So the first run now says exactly what it did and stops, rather than
      // claiming a comparison it did not make. The protection is unchanged where
      // it matters: on any run that HAS a baseline, a drifted string still fails
      // below.
      markTestSkipped(
        'baseline did not exist and was just written '
        '(\${now.values.first.length} getters x \${now.length} locales). '
        'NOTHING WAS COMPARED in this run — re-run to compare against it.',
      );
      return;
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
  const wanted = emitTest(getters);

  // 🔴 --check exists because of a real regression, and it is worth stating what
  // it was: on 2026-08-14 the emitted test was corrected BY HAND (the missing
  // baseline was made a skip instead of a failure, measured inside an exported
  // tree). The generator kept emitting the old arm. The next regeneration —
  // 2026-08-17, during the 0.3.8 release — silently put the failure back, and
  // the open-source repo's flutter job went red on the release commit.
  //   ⇒ A fix that lives only in a generated artefact is undone by the next
  //     `--emit-test`, and nothing was watching, because this generator was the
  //     one i18n generator with no row in verify/lint/i18n-generated-fresh.mjs.
  // It has a row now, and that row calls this.
  if (process.argv.includes('--check')) {
    const onDisk = existsSync(TEST) ? readFileSync(TEST, 'utf8') : null;
    if (onDisk === null) {
      console.error(`missing: ${path.relative(ROOT, TEST)} — run --emit-test`);
      process.exitCode = 1;
      return;
    }
    if (onDisk !== wanted) {
      console.error(
        `stale: ${path.relative(ROOT, TEST)} differs from what the generator emits `
        + '(hand-edited, or the getter surface moved) — run --emit-test',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`fresh: ${path.relative(ROOT, TEST)} (${getters.length} getters)`);
    return;
  }

  console.log(`walkable public getters: ${getters.length}`);
  if (!process.argv.includes('--emit-test')) {
    console.log('(pass --emit-test to write the Dart harness, --check to verify it is fresh)');
    return;
  }
  mkdirSync(path.dirname(GOLDEN), { recursive: true });
  writeFileSync(TEST, wanted);
  console.log(`wrote: ${path.relative(ROOT, TEST)}`);
  console.log('next : cd apps/mobile && flutter test test/i18n_migration_golden_test.dart  (writes the golden, skips on purpose)');
  console.log('then : run it again — it must pass BEFORE you migrate.');
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('snapshot-rendered.mjs')) main();
