#!/usr/bin/env node
// Drill for scripts/require-programfiles-x86.mjs.
//
// The guard is Windows-only: `ProgramFiles(x86)` can never exist on macOS or
// Linux, so the guard must exit 0 there instead of refusing every non-Windows
// run of `make -C apps/mobile ...`. This drill exercises the non-Windows
// branch from whatever host runs the test, via `FLOWMIC_TEST_FORCE_PLATFORM`
// — a variable the guard script itself documents as test-only. It does not
// change what the guard does on a real Windows host, which the Windows-path
// assertions below also pin.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'require-programfiles-x86.mjs');

let failures = 0;
function assertTrue(cond, label) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

// 🔴 `drop` is not a convenience. The overlay form (`{ ...process.env, ...env }`)
// cannot express "this variable is ABSENT": deleting a key from the overlay
// leaves the inherited one standing. On a bare Git Bash shell that difference is
// invisible, because the shell cannot even spell `ProgramFiles(x86)`. Inside a
// ship run it is fatal: ship sets that variable on every child BY DESIGN, so the
// two "missing" cases here silently became "present" cases and this drill failed
// on a guard that works [measured 2026-09-18, .local/gate-release/SCRIPTS.log].
function run(env, drop = []) {
  const merged = { ...process.env, ...env };
  for (const k of drop) delete merged[k];
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: merged,
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// --- non-Windows: must skip (exit 0), regardless of the real host platform,
// and regardless of whether ProgramFiles(x86) happens to be set. ---
{
  const env = { FLOWMIC_TEST_FORCE_PLATFORM: 'darwin' };
  const r = run(env);
  assertTrue(r.code === 0, 'darwin (spoofed): exits 0');
  assertTrue(/Windows-only/.test(r.out), 'darwin (spoofed): says Windows-only, not a real refusal');
}

// --- Windows: variable set -> pass. Variable missing -> refuse (exit 1). ---
{
  const r = run({ FLOWMIC_TEST_FORCE_PLATFORM: 'win32', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' });
  assertTrue(r.code === 0, 'win32 (spoofed) + var set: exits 0');
}
{
  const r = run({ FLOWMIC_TEST_FORCE_PLATFORM: 'win32' }, ['ProgramFiles(x86)']);
  assertTrue(r.code === 1, 'win32 (spoofed) + var missing: refuses (exit 1)');
  assertTrue(/is missing from this process env/.test(r.out), 'win32 refusal names the missing variable');
}

// --- REVERSE CONTROL (documented here, run by hand, not automated): removing
// the `if (PLATFORM !== 'win32') { ... process.exit(0); }' guard block makes
// the first case above (darwin, var unset) exit 1 instead of 0 — i.e. this
// drill does catch the regression it exists to catch. Restored after
// confirming red; see the commit history for this file. ---

if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('require-programfiles-x86: all checks passed.');
