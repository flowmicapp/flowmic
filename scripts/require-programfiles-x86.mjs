#!/usr/bin/env node
// The `ProgramFiles(x86)` guard that apps/mobile/Makefile puts in front of every
// `flutter` invocation — as a FILE, because the one-liner it replaces was only
// ever valid in one of the two shells that run that Makefile.
//
// 🔴 WHAT WENT WRONG, MEASURED (2026-09-17, the first `verify:delivery:release`
// of the merged ship-chain tree). The guard was written as:
//
//     @node -e 'process.exit(process.env["ProgramFiles(x86)"] ? 0 : 1)' \
//       || { echo '...'; exit 1; }
//
// Single quotes around the script, double quotes inside, and an sh brace group
// after `||`. Run from Git Bash — where GNU make finds `sh` and uses it — that
// is correct, and it is how every human had ever run it. Run from the release
// gate, where make is reached through pnpm/cmd and uses **cmd.exe** as its
// shell, cmd strips the double quotes and keeps the single ones, so node was
// handed `'process.exit(process.env[ProgramFiles(x86)]` and died on
// `Unterminated string constant`. The MOBILE lane went red with a syntax error
// inside its own guard, on a machine where the variable was in fact set.
//
// ⚠️ NOTE WHICH WAY IT FAILED: closed, not open. make still stopped, so nothing
// untested slipped through — the cost was a red lane whose message pointed at
// nothing real, which is its own kind of expensive: a gate that fails for a
// reason that is not about the product is a gate people start re-running until
// it is green.
//
// A file has no quoting surface at all. `node <path>` is the same string in sh,
// in cmd and in PowerShell, so this cannot drift apart from whichever shell make
// happens to pick up next.
//
// WHY THE GUARD EXISTS AT ALL: with `ProgramFiles(x86)` missing from the process
// environment, `flutter` exits almost immediately with an error that says
// nothing about the environment. Every second spent on it is spent looking at
// Dart. See scripts/ship-preflight.mjs, which checks the same variable before a
// gate rather than during one.

const KEY = 'ProgramFiles(x86)';

// `ProgramFiles(x86)` can never exist outside Windows — it is not a Flutter
// requirement, it is a Windows environment-variable convention. Running this
// guard on the Mac mini (or Linux CI) made the mobile lane structurally red
// there for a reason that has nothing to do with the product: this check, not
// flutter, refused to run. `FLOWMIC_TEST_FORCE_PLATFORM` exists ONLY so the
// drill test can exercise the non-Windows branch from a Windows dev machine;
// it is not read anywhere else in this repo and is not a supported override
// for real invocations.
const PLATFORM = process.env.FLOWMIC_TEST_FORCE_PLATFORM || process.platform;

if (PLATFORM !== 'win32') {
  console.log(`${KEY} check skipped — Windows-only, this host is ${PLATFORM}.`);
  process.exit(0);
}

if (process.env[KEY]) process.exit(0);

console.error(`${KEY} is missing from this process env — flutter dies on it instantly.`);
console.error('  Git Bash:    env "ProgramFiles(x86)=C:\\Program Files (x86)" <this make command>');
console.error('  PowerShell:  ${env:ProgramFiles(x86)} = "C:\\Program Files (x86)"');
console.error('  cmd:         set "ProgramFiles(x86)=C:\\Program Files (x86)"');
console.error('  (scripts/ship-preflight.mjs checks this before a gate run, not during one.)');
process.exit(1);
