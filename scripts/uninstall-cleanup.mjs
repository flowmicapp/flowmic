// FlowMic post-uninstall cleanup (S6, 0.3.0).
//
// SPEC-REF:
//   docs/strategy/2026-08-04-0.3.0-task-book-cn.md S6
//   apps/desktop/src-tauri/src/socket/credentials.rs (LAN credential, DPAPI)
//   apps/desktop/src-tauri/src/socket/channel.rs (cloud credential + config +
//     typed-ledger, all DPAPI/state, all siblings of credentials.bin)
//   apps/desktop/src-tauri/src/forensic.rs (window-forensics.log)
//   apps/desktop/src-tauri/src/shell/autostart.rs (HKCU Run key, value name =
//     the cargo package name "flowmic-desktop" — see Cargo.toml [package] name)
//   scripts/install-local.mjs header (already documents, in a different context,
//     that %LOCALAPPDATA%\FlowMic\ is the RUNTIME DATA dir, separate from any
//     install directory)
//
// ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────
// Neither the MSI uninstaller nor the portable bundle's own 使用说明.txt removes
// what actually constitutes "this machine's FlowMic identity": two DPAPI
// credential files, the cloud config, the dedup ledger, both diagnostic logs,
// and a Windows Run-key autostart entry that (once the exe is gone) points at a
// deleted file. MSI/WiX only ever removes what it itself put under Program
// Files; it has no idea the running app wrote things elsewhere at runtime, so
// none of the above is "uninstalled" by uninstalling — measured (task card S6).
//
// ── WHAT THIS SCRIPT DOES **NOT** TOUCH, AND WHY ─────────────────────────────
// `%APPDATA%\FlowMic\` (flowmic.sqlite, standalone.secret, instance.lock) is
// NEVER referenced anywhere below — not behind a flag, not in dry-run output.
// That directory holds the user's actual message/transcript records
// (flowmic.sqlite) and the secret needed to decrypt them (standalone.secret);
// deleting a user's data as a side effect of "uninstall cleanup" is its own
// defect class (task card S6 red line) and this script structurally cannot do
// it, because the path is not constructed anywhere in this file. See "MANUAL
// STEPS" printed at the end for how the OWNER removes that themselves, on
// purpose, with full knowledge of what it erases.
//
// `%LOCALAPPDATA%\FlowMic\timeline-images\` is also left alone (not even under
// --yes): it caches the actual pictures injected into timeline rows, which
// reads more like user content than like credential/session state, and this
// script only ever deletes things that are unambiguously the latter.
//
// ── SCOPE ─────────────────────────────────────────────────────────────────
// Windows only (everything this removes is a Windows-only artifact: DPAPI
// blobs and an HKCU Run key). Safe to run whether the app was installed via
// MSI or unpacked as the portable bundle — both share the exact same
// `%LOCALAPPDATA%\FlowMic\` state directory and the same Run-key value name
// (publish.mjs 使用说明.txt: "与 MSI 安装版共用同一份数据").
//
// 🔴 Run this AFTER you are done with FlowMic on this machine, not while any
// copy (MSI-installed or portable) is still in use: it deletes the pairing
// credentials and cloud session for BOTH, and disables autostart for whichever
// one is currently registered. There is exactly one Run-key value name shared
// by both install shapes (autostart.rs header comment, known risk), so this script cannot
// tell "which install" any more than Windows can — it removes the one shared
// value, matching the one shared state directory it also cleans.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const HELP = args.includes('--help') || args.includes('-h');

if (HELP) {
  console.log(`FlowMic uninstall cleanup (S6)

Usage:
  node scripts/uninstall-cleanup.mjs             # preview what would be deleted; touch no files/registry
  node scripts/uninstall-cleanup.mjs --yes       # actually delete

Deletes only "credentials/state", never touches "user data" (%APPDATA%\\FlowMic\\ and
%LOCALAPPDATA%\\FlowMic\\timeline-images\\ are completely outside this script's path
construction — this is not an option a flag can turn on; those two paths are not
written anywhere in this file).

Will delete (only if present; skip if absent):
  · %LOCALAPPDATA%\\FlowMic\\credentials.bin           (LAN pairing credential, DPAPI)
  · %LOCALAPPDATA%\\FlowMic\\credentials-cloud.bin      (cloud pairing credential, DPAPI)
  · %LOCALAPPDATA%\\FlowMic\\cloud.bin                  (cloud endpoint + Cloud Key, DPAPI)
  · %LOCALAPPDATA%\\FlowMic\\typed-ledger.json          (dedup ledger, pure state)
  · %LOCALAPPDATA%\\FlowMic\\typed-ledger-cloud.json    (same, historical filename)
  · %LOCALAPPDATA%\\FlowMic\\window-forensics.log       (diagnostic log)
  · %LOCALAPPDATA%\\FlowMic\\server.log                 (diagnostic log)
  · the autostart value named "flowmic-desktop" under
    HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run
    (whether or not the exe it currently points at still exists)

Will never delete (this script does not have these paths; this is not a "default-off"):
  · %APPDATA%\\FlowMic\\flowmic.sqlite      —— your actual messages/transcript records
  · %APPDATA%\\FlowMic\\standalone.secret   —— the key needed to decrypt that database
  · %APPDATA%\\FlowMic\\instance.lock       —— single-instance lock, harmless, also not this script's job
  · %LOCALAPPDATA%\\FlowMic\\timeline-images\\ —— cache of pictures injected into the timeline
`);
  process.exit(0);
}

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('✗ no %LOCALAPPDATA% (not Windows, or the env var was cleared) — this script is Windows-only.');
  process.exit(1);
}
const STATE_DIR = join(localAppData, 'FlowMic');

// The exact filenames the app itself writes — kept in one place, sourced from
// the same names the Rust side uses (see SPEC-REF above), so this list cannot
// silently drift from what credentials.rs / channel.rs / forensic.rs actually
// write.
const REMOVABLE_FILES = [
  'credentials.bin',
  'credentials-cloud.bin',
  'cloud.bin',
  'typed-ledger.json',
  'typed-ledger-cloud.json',
  'window-forensics.log',
  'server.log',
];

// HKCU Run key — matches autostart.rs RUN_KEY and the value name
// (app.package_info().name == Cargo.toml [package] name == "flowmic-desktop").
const RUN_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE_NAME = 'flowmic-desktop';

// stdio explicitly piped (not inherited): `reg.exe` writes "unable to find …"
// to stderr on the expected "not present" path, and without this it would leak
// straight through to our own stderr and read like a real error on every clean
// machine.
function queryRunValue() {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE_NAME], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(RUN_VALUE_NAME));
    return line ? line.trim() : out.trim();
  } catch {
    return null; // not present — reg exits non-zero, stderr swallowed above
  }
}

function deleteRunValue() {
  execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

console.log(YES ? '── running uninstall cleanup (--yes) ──' : '── uninstall cleanup preview (without --yes this only shows, does not delete; add --yes to actually delete) ──');

const found = [];
const missing = [];
if (existsSync(STATE_DIR)) {
  for (const name of REMOVABLE_FILES) {
    const p = join(STATE_DIR, name);
    if (existsSync(p)) found.push({ name, path: p, size: statSync(p).size });
    else missing.push(name);
  }
} else {
  console.log(`· ${STATE_DIR} does not exist — no state files to clear (already clean, or FlowMic has never run on this machine)`);
  for (const name of REMOVABLE_FILES) missing.push(name);
}

for (const f of found) {
  const kib = (f.size / 1024).toFixed(1);
  if (YES) {
    try {
      rmSync(f.path, { force: true });
      console.log(`✓ deleted ${f.name}  (${kib} KiB)`);
    } catch (e) {
      console.error(`✗ failed to delete ${f.name}: ${e.message}`);
    }
  } else {
    console.log(`  will delete  ${f.name}  (${kib} KiB)  ${f.path}`);
  }
}
for (const name of missing) console.log(`  · ${name}  —— absent, skip`);

const registered = queryRunValue();
if (registered) {
  console.log(`\nautostart entry present: ${registered}`);
  if (YES) {
    try {
      deleteRunValue();
      console.log('✓ deleted autostart registry value (HKCU Run\\flowmic-desktop)');
    } catch (e) {
      console.error(`✗ failed to delete autostart registry value: ${e.message}`);
    }
  } else {
    console.log('  will delete  HKCU Run\\flowmic-desktop');
  }
} else {
  console.log('\n· autostart registry value absent —— skip');
}

// timeline-images: reported, never deleted, on purpose (see header).
const timelineImages = join(STATE_DIR, 'timeline-images');
let timelineNote = 'directory does not exist';
if (existsSync(timelineImages)) {
  const n = readdirSync(timelineImages).length;
  timelineNote = `${n} files; this script will not touch it (see "will not delete" below)`;
}
console.log(`\n· ${timelineImages}\n  ${timelineNote}`);

console.log(`
── will not delete (this script never wrote these paths; this is not a switch that was turned off) ──
  %APPDATA%\\FlowMic\\flowmic.sqlite       your actual messages/transcript records
  %APPDATA%\\FlowMic\\standalone.secret    the key needed to decrypt that database
  %APPDATA%\\FlowMic\\instance.lock        single-instance lock, harmless
  %LOCALAPPDATA%\\FlowMic\\timeline-images\\  cache of pictures injected into the timeline

To clear these as well (this also deletes your historical messages — be sure you mean it):
  rmdir /s /q "%APPDATA%\\FlowMic"
  rmdir /s /q "${timelineImages}"
`);

if (!YES) {
  console.log('This is a preview. Add --yes to actually delete the files/registry values marked "will delete" above.');
}
