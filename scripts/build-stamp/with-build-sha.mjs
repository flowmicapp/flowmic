#!/usr/bin/env node
// scripts/build-stamp/with-build-sha.mjs — card SC-5.
//
// Runs a build command with this tree commit sha attached, in the two shapes
// the two toolchains need:
//
//   · ENV      FLOWMIC_BUILD_SHA=<value> in the child environment, which
//              apps/desktop/src-tauri/build.rs reads and re-emits as a
//              `cargo:rustc-env`, so `env!("FLOWMIC_BUILD_SHA")` compiles the
//              value into the exe string table.
//   · ARGV     every literal `{sha}` in the remaining arguments is replaced by
//              the value, because `--dart-define=` needs it ON THE COMMAND
//              LINE (Dart does not read the process environment at compile
//              time).
//
// Usage:  node scripts/build-stamp/with-build-sha.mjs -- <command> [args...]
//         node scripts/build-stamp/with-build-sha.mjs <command> [args...]
//
// ── 🔴 WHY A NODE RUNNER AND NOT `VAR=x cmd` OR `$(git rev-parse HEAD)` ──────
//
// Measured, in this repo, on this card list. The 2026-09-17 integration round
// lost a whole lane to exactly this: apps/mobile/Makefile guarded
// `ProgramFiles(x86)` with `node -e '..."..."...'`, which is correct from Git
// Bash and explodes when the release gate reaches it through pnpm/cmd (cmd
// strips the double quotes and leaves the single ones). The fix there was the
// same as the shape here — put the logic in a FILE, because a file path is the
// same string in every shell.
//
// `$(node ...)` in a Makefile has a second, worse failure: make does not stop
// when a `$(shell ...)` fails. A refusal would come back as an EMPTY value and
// the build would carry on and stamp nothing — a refusal that silently becomes
// a pass is the one shape this card exists to remove. This runner resolves the
// value FIRST and never spawns the child if the rule refuses, so a refusal is
// a non-zero exit before any byte is built.
//
// The child exit code is this process exit code, and a signal death is
// reported rather than collapsed into 0.

import { spawnSync } from 'node:child_process';

import { BUILD_SHA_ENV, resolveBuildSha } from './require-clean-sha.mjs';

const PLACEHOLDER = '{sha}';

export function substitute(args, value) {
  return args.map((a) => (a.includes(PLACEHOLDER) ? a.split(PLACEHOLDER).join(value) : a));
}

function main(argv) {
  const rest = argv[0] === '--' ? argv.slice(1) : argv;
  if (rest.length === 0) {
    process.stderr.write(
      'usage: node scripts/build-stamp/with-build-sha.mjs -- <command> [args...]\n' +
        `       (sets ${BUILD_SHA_ENV} in the child env, and replaces every literal ` +
        `${PLACEHOLDER} in the arguments)\n`,
    );
    return 2;
  }

  let stamp;
  try {
    stamp = resolveBuildSha();
  } catch (e) {
    process.stderr.write(`x build stamp refused, NOT running the build:\n  ${e.message}\n`);
    return 1;
  }

  const [cmd, ...args] = substitute(rest, stamp.value);
  process.stderr.write(
    `· build stamp ${BUILD_SHA_ENV}=${stamp.value} (${stamp.form}) -> ${cmd} ${args.join(' ')}\n`,
  );

  // `shell: true` on Windows, because the commands this wraps (`tauri`,
  // `flutter`) are .cmd/.bat shims that CreateProcess cannot execute directly.
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, [BUILD_SHA_ENV]: stamp.value },
    shell: process.platform === 'win32',
  });
  if (r.error) {
    process.stderr.write(`x could not run \`${cmd}\`: ${r.error.message}\n`);
    return 1;
  }
  if (r.signal) {
    process.stderr.write(`x \`${cmd}\` was killed by ${r.signal}\n`);
    return 1;
  }
  return r.status ?? 1;
}

if (process.argv[1] && process.argv[1].endsWith('with-build-sha.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
