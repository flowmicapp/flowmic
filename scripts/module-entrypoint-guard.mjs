// scripts/module-entrypoint-guard.mjs
// Make a library module say so when somebody runs it directly.
//
// WHY THIS EXISTS (2026-08-10, coordinator, twice in one session)
// ---------------------------------------------------------------
// Several of this repo's gates are pure-function modules: they export a
// `scan…()` and are called by a runner (`scripts/publish-apk-gates.mjs`,
// `verify/lint/run-all.mjs`). Running one of those files directly does exactly
// what ESM says it should — it evaluates the module body, which only defines
// things — and exits 0 with no output.
//
// `EXIT=0` and no output is indistinguishable from "the check ran and passed".
// It cost this repo twice in one afternoon:
//   1. `node verify/lint/platform-cfg-count.mjs` → EXIT=0 → written down as
//      "the tripwire did not fire" on a branch that added five `cfg(unix)`
//      sites. It fires correctly; it just had not been invoked. That wrong
//      note was minutes from becoming "the gate I built yesterday is a facade".
//   2. `node scripts/apk-disclosure-copy-marker.mjs <apk>` → EXIT=0 → read as
//      "the 0.2.61 APK passes the disclosure gate". Nothing had scanned it.
// Both times the recovery was luck: the number looked too clean.
//
// The rule already in CLAUDE.md — a discipline that has been missed twice
// should be automated — applies to the person writing this comment. So:
//
//   refuseDirectRun(import.meta.url, 'node scripts/publish-apk-gates.mjs …');
//
// at the top of a library module turns the silent 0 into a loud 2.
//
// ⚠️ WHAT THIS IS NOT. It does not check that a gate is wired into anything,
// and it cannot: a module can be imported by a runner nobody calls. Wiring is
// still proven by the drills (`scripts/*.test.mjs` grep the runner's source for
// the import). This only removes ONE way to mistake silence for a pass.
//
// ⚠️ The comparison must never fire under `import`, because these modules are
// on the publish path — a false positive here refuses to ship a good build.
// That is why it compares resolved real paths rather than matching on argv
// text, and why `scripts/module-entrypoint-guard.test.mjs` drives both
// directions.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// True only when node was started with THIS module file as its entry script.
// `process.argv[1]` is absent under `node -e` / `--input-type=module`, which
// counts as "not a direct run" — that is a caller deliberately composing the
// exports, exactly what the exports are for.
export function isDirectRun(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(moduleUrl));
  } catch {
    // A non-file URL (data:, node:) is never the entry script.
    return false;
  }
}

// Exit 2 with the entry point the caller should have used. Exit 2, not 1, so a
// script that greps for a gate's own failure code cannot read "you invoked this
// wrong" as "the artifact failed".
export function refuseDirectRun(moduleUrl, useInstead) {
  if (!isDirectRun(moduleUrl)) return;
  const self = path.basename(fileURLToPath(moduleUrl));
  process.stderr.write(
    `${self} is a library module, not a command.\n` +
      `Running it directly evaluates its exports and exits 0 — which looks\n` +
      `exactly like a passing check, and is not one.\n\n` +
      `  use: ${useInstead}\n`,
  );
  process.exit(2);
}
