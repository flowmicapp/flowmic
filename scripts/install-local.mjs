// FlowMic local run-copy installer — RV-73 (owner 2026-07-31 ruling: run directory and artifact directory are separate).
//
// WHY THIS FILE EXISTS
// --------------------
// `publish/` used to be BOTH the release staging directory AND the directory the
// owner actually ran FlowMic from. One directory answering two questions is this
// repo's #1 bug shape, and here it had a deterministic operational cost: while the
// owner's portable FlowMic was running, Windows held a write lock on
// `publish\FlowMic-portable\FlowMic.exe`, so EVERY publish ended in
// `EBUSY: resource busy or locked, copyfile …`. Not an occasional glitch — every
// round (measured, 窗口B1 close-out).
//
// owner's ruling (docs/decisions/2026-07-31-owner-b2-outbox-rulings.md §Options 4,
// three options offered): `publish/` holds ONLY artifacts to be distributed; the
// running copy lives somewhere else; the publish script never touches it. The two
// rejected options were "make publish refuse loudly" and "agree by convention to
// quit first" — both leave the two roles in one directory.
//
// So this script is the OTHER half of that ruling: getting a freshly published
// bundle into the run directory is now an explicit, named, noisy action instead of
// a side effect of publishing.
//
// WHY THE DEFAULT IS %LOCALAPPDATA%\Programs\FlowMic\
// ---------------------------------------------------
//   · it is the documented per-user application-install location on Windows (the
//     same one VS Code's User Installer and Squirrel/Electron apps use), so it
//     needs no elevation and no ACL surgery;
//   · it is deliberately NOT `%LOCALAPPDATA%\FlowMic\` and NOT a subdirectory of
//     it: that directory already holds RUNTIME DATA (`window-forensics.log`,
//     `server.log`, `credentials.bin`). Binaries and data in one tree means the
//     "clear the logs" gesture (`rm -rf %LOCALAPPDATA%\FlowMic`) also deletes the
//     application, and the "uninstall by deleting the folder" gesture (which the
//     portable bundle's own 使用说明.txt teaches) also deletes the credentials.
//     Two lifetimes, two directories — the same separation this whole card is about;
//   · it is deliberately NOT `C:\FlowMic\`: a directory created at the root of C:
//     inherits permissive ACLs that let any authenticated user replace the exe,
//     which is a binary-planting footgun — and worth stating explicitly because the
//     shells this repo's agents run in are already elevated (CLAUDE.md 环境事实),
//     so "it worked when I tried it" proves nothing about a normal user account.
//
// Override with the env var below or `--dest`; nothing here is hard-coded to any
// particular machine's layout.
//
// THE HARD RULE
// -------------
// This script must never write ANYTHING when the destination is in use. It probes
// every file it is about to overwrite BEFORE it copies the first byte, and it also
// asks the app's own single-instance lock whether a FlowMic is running at all. A
// half-written run directory (new sidecar, old exe) is a worse outcome than not
// updating, and this repo has already paid once for an unplanned partial write.

import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = join(ROOT, 'publish');
/** What `scripts/publish.mjs` stages. This script only ever READS from here. */
const SOURCE = join(PUBLISH, 'FlowMic-portable');

/** Env override for the run directory. Consumers: this file only (by design —
 *  it is read once, here, and printed in every run so it is never a hidden knob). */
const INSTALL_DIR_ENV = 'FLOWMIC_LOCAL_INSTALL_DIR';
/** Default run directory, relative to %LOCALAPPDATA% — see the header for why. */
const DEFAULT_INSTALL_DIR_PARTS = ['Programs', 'FlowMic'];

/** Without these four the bundle is not runnable, so refuse to stage a corpse.
 *  `resources/package.json` is `{"type":"module"}`: the sidecar is an ESM bundle
 *  in a `.js`, and without that marker an older Node loads it as CJS and dies on
 *  the first `import` (2026-08-03). The private node.exe beside it is new enough
 *  that this run copy would survive without it — it is required anyway so a
 *  half-staged directory is caught here rather than at somebody's device page. */
const REQUIRED_FILES = [
  'FlowMic.exe',
  'node.exe',
  join('resources', 'server.js'),
  join('resources', 'package.json'),
  // ENG-1 / fix-028 — the stock STT seed is `builtin-sherpa-local`
  // (server-core settings/defaults.ts), so a portable payload without the addon
  // is not「少了个可选功能」, it is an install whose FIRST utterance dies on
  // `Cannot find module 'sherpa-onnx-node'` and tells the user 「没有听到语音」.
  // Before this, `listTree` copied whatever was there and this completeness
  // check had no opinion — a bundle missing the addon installed cleanly.
  // The NATIVE binary is named rather than the package dir: the half-staged
  // shape (glue present, native absent) resolves and still cannot transcribe,
  // so the directory's existence is not the fact worth asserting.
  join('resources', 'node_modules', 'sherpa-onnx-node', 'package.json'),
  join('resources', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'),
];
/** Copied first: the files Windows locks while FlowMic runs. If the pre-flight
 *  probe were ever wrong, failing on the FIRST file leaves the least mess. */
const RISKIEST_FIRST = ['FlowMic.exe', 'node.exe'];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const mb = (n) => (n / 1024 / 1024).toFixed(1);
const ok = (m) => console.log(`✓ ${m}`);
const info = (m) => console.log(`· ${m}`);
const warn = (m) => console.log(`⚠ ${m}`);

function die(lines) {
  for (const l of [].concat(lines)) console.error(l);
  process.exit(1);
}

const HELP = `
FlowMic — update the local run copy (RV-73)

  node scripts/install-local.mjs [--dest <dir>] [--dry-run] [--help]
  pnpm run install:local -- [--dest <dir>] [--dry-run]

Copy the just-published portable bundle in publish/FlowMic-portable/ into your [run directory].
publish/ only holds artifacts waiting to be distributed; nobody should launch FlowMic from
there — that is exactly why every publish round hit EBUSY (RV-73).

How the run directory is chosen (highest priority first)
  1. --dest <dir>
  2. env var ${INSTALL_DIR_ENV}
  3. default %LOCALAPPDATA%\\${DEFAULT_INSTALL_DIR_PARTS.join('\\')}\\
     (deliberately not %LOCALAPPDATA%\\FlowMic\\ — that is where logs and credentials live;
       binaries and data must not share one directory that can be deleted as a whole)

What it will never do
  · will not write a single byte while FlowMic is running. Probe first, then write;
    if occupancy is found, stop the whole run and tell you what to quit — never write half.
  · will not delete files in the run directory that it did not bring (report only).
  · will not touch publish/.

Options
  --dest <dir>   run directory for this invocation (not written into any config; this run only)
  --dry-run      print what would be done, write nothing
  --help         this text
`.trimStart();

function parseArgs(argv) {
  const out = { help: false, dryRun: false, dest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm run install:local -- --dry-run` forwards the `--` LITERALLY (measured
    // on pnpm 9.15.9: the child sees ["--","--dry-run"]). Swallow it rather than
    // reject it, or the documented invocation dies on its own separator.
    if (a === '--') continue;
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--dest') {
      out.dest = argv[++i] ?? null;
      if (!out.dest) die('✗ --dest must be followed by a directory');
    } else if (a.startsWith('--dest=')) out.dest = a.slice('--dest='.length);
    else die([`✗ unrecognized argument: ${a}`, '', HELP]);
  }
  return out;
}

/** Resolve the run directory + say out loud WHERE that answer came from. */
function resolveInstallDir(cliDest) {
  if (cliDest) return { dir: resolve(cliDest), from: '--dest' };
  const env = process.env[INSTALL_DIR_ENV];
  if (env && env.trim()) return { dir: resolve(env.trim()), from: `$${INSTALL_DIR_ENV}` };
  const local = process.env.LOCALAPPDATA;
  if (!local) {
    die([
      `✗ no %LOCALAPPDATA%, and neither --dest / $${INSTALL_DIR_ENV} was given — nowhere to install.`,
      '  (normal when this script is run off Windows: pass a directory explicitly.)',
    ]);
  }
  return { dir: join(local, ...DEFAULT_INSTALL_DIR_PARTS), from: 'default' };
}

/** true when `child` is `parent` or lives under it. */
function isInside(child, parent) {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}

/** Every file under `dir`, as paths relative to `dir`. */
function listTree(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, e.name) : e.name;
    if (e.isDirectory()) out.push(...listTree(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** null = writable / absent. Otherwise the errno that says why not.
 *  `r+` asks for WRITE access on purpose: that is the access a running exe's
 *  image denies (ERROR_SHARING_VIOLATION → EBUSY), which is exactly the failure
 *  publish.mjs kept hitting. Read access would happily succeed and prove nothing. */
function probeWritable(p) {
  let fd;
  try {
    fd = openSync(p, 'r+');
  } catch (e) {
    return e.code === 'ENOENT' ? null : e.code || 'EUNKNOWN';
  }
  closeSync(fd);
  return null;
}

/** Is a FlowMic — ANY FlowMic, portable or MSI — running right now?
 *
 *  Asks the app's own single-instance lock, resolved the same way the app does
 *  (`%APPDATA%\FlowMic\instance.lock`, sidecar/io.rs default_home +
 *  single_instance.rs). The app opens it with dwShareMode=0, so any open at all
 *  fails while it is held. Read-only open, never created here: this must not be
 *  able to manufacture the very state it reports on.
 *
 *  Answers a DIFFERENT question from probeWritable() (which asks "can I write
 *  THIS file"), and both are reported separately for that reason. */
function runningInstance() {
  const appdata = process.env.APPDATA;
  if (!appdata) return { known: false, held: false, path: null };
  const p = join(appdata, 'FlowMic', 'instance.lock');
  if (!existsSync(p)) return { known: true, held: false, path: p };
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch (e) {
    return { known: true, held: true, path: p, code: e.code };
  }
  closeSync(fd);
  return { known: true, held: false, path: p };
}

/** What the exe itself declares, read out of its Win32 VERSIONINFO resource.
 *
 *  The lesson this repo paid for twice (13 册 D5, then card PUB on the APK): a
 *  filename — and equally a text file sitting next to the binary — describes
 *  intent, not the artifact. The FileVersion string inside the PE is the row
 *  Windows itself shows in the file properties dialog, so it is the one that
 *  survives a careless copy. Byte-scanned rather than parsed as a resource tree:
 *  that is enough to READ a value, and this function never claims more than it
 *  found (null → the caller says so out loud instead of guessing). */
function exeDeclaredVersion(exePath) {
  let buf;
  try {
    buf = readFileSync(exePath);
  } catch {
    return null;
  }
  const key = buf.indexOf(Buffer.from('FileVersion', 'utf16le'));
  if (key < 0) return null;
  const tail = buf.subarray(key, key + 200).toString('utf16le');
  const m = /^FileVersion\u0000+(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(tail);
  return m ? m[1] : null;
}

// ── go ──────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

// 1. the source must be a real, complete portable bundle.
if (!existsSync(SOURCE)) {
  die([
    `✗ no ${SOURCE}`,
    '  produce artifacts, then publish: `pnpm --filter @flowmic/desktop tauri:build` → `node scripts/publish.mjs`',
  ]);
}
const missing = REQUIRED_FILES.filter((f) => !existsSync(join(SOURCE, f)));
if (missing.length > 0) {
  die([
    `✗ ${SOURCE} is not a complete portable bundle, missing: ${missing.join(', ')}`,
    '  re-run `node scripts/publish.mjs`.',
  ]);
}

// 2. where it goes — and where that answer came from.
const { dir: DEST, from: destFrom } = resolveInstallDir(args.dest);
if (isInside(DEST, PUBLISH) || isInside(PUBLISH, DEST)) {
  die([
    `✗ the run directory cannot be publish/ or above/below it: ${DEST}`,
    '  that is exactly what RV-73 exists to fix: artifact area and run area at the same path ⇒ every publish round is EBUSY.',
  ]);
}

const files = listTree(SOURCE);
const ordered = [...RISKIEST_FIRST.filter((f) => files.includes(f)), ...files.filter((f) => !RISKIEST_FIRST.includes(f))];
const totalBytes = files.reduce((n, f) => n + statSync(join(SOURCE, f)).size, 0);

// 3. what we are about to do — printed before anything happens, every run.
const declared = exeDeclaredVersion(join(SOURCE, 'FlowMic.exe'));
const sourceVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
console.log('── update the local run copy ──');
info(`source  ${SOURCE}`);
info(`dest    ${DEST}   [${destFrom}]`);
info(`payload ${files.length} files / ${mb(totalBytes)} MB`);
if (declared) ok(`FlowMic.exe in the portable bundle self-attests FileVersion=${declared} (read from PE VERSIONINFO, not the filename and not a sidecar text file)`);
else warn('could not read FileVersion from FlowMic.exe — not a blocker, but this copy cannot self-attest its version');
if (declared && declared !== sourceVersion) {
  warn(`this artifact is ${declared}, while the source tree is already ${sourceVersion} — the version was bumped but the package has not been rebuilt.`);
  warn('  to install the current source version: tauri:build + publish first, then come back and run this.');
}

// 4. 🔴 pre-flight. Nothing above wrote anything; nothing below writes until
//    every one of these passes.
const blocked = [];
for (const f of ordered) {
  const code = probeWritable(join(DEST, f));
  if (code) blocked.push({ f, code });
}
const inst = runningInstance();

if (blocked.length > 0 || inst.held) {
  const msg = ['', '✗ stopped — not a single byte was written.', ''];
  if (blocked.length > 0) {
    // Square brackets print the real errno: most of the time it is EBUSY = the
    // running program image is locked by Windows, but EACCES / EISDIR also land
    // here, and those are not "occupied" — do not draw that conclusion for the reader.
    msg.push('  these files in the dest directory cannot be written right now ([] is the reason the OS gave; EBUSY = the running program image is locked):');
    for (const b of blocked) msg.push(`    ${join(DEST, b.f)}   [${b.code}]`);
    msg.push('');
  }
  if (inst.held) {
    msg.push(`  ${blocked.length > 0 ? 'and a' : 'a'} FlowMic is running: the single-instance lock ${inst.path} is held exclusively.`);
    msg.push('  (it may be this copy in the dest directory, or the MSI install — quit first in either case:');
    msg.push('    updating a running copy produces "half new, half old", and launching immediately after install will also bounce off this lock.)');
    msg.push('');
  }
  msg.push('  what to do: right-click the tray icon and quit FlowMic (or end FlowMic.exe), then re-run this command.');
  msg.push('  Quit the running FlowMic first, then re-run this command.');
  die(msg);
}
ok(`dest directory is writable: ${ordered.length} dest files probed one by one (none occupied), single-instance lock ${inst.known ? 'is not held' : 'cannot be judged (no %APPDATA%)'}`);

// Leftovers are reported, never deleted: the run directory belongs to the owner,
// and silently removing something we did not put there is not ours to do.
if (existsSync(DEST)) {
  const extra = listTree(DEST).filter((f) => !files.includes(f));
  if (extra.length > 0) warn(`the run directory has ${extra.length} leftover file(s) this run will not overwrite (kept, not deleted): ${extra.slice(0, 8).join(', ')}`);
}

if (args.dryRun) {
  console.log('');
  ok('--dry-run: the checks above all passed, but nothing was written, as requested.');
  process.exit(0);
}

// 5. copy, riskiest first, and verify each landed byte-identical.
const written = [];
try {
  mkdirSync(DEST, { recursive: true });
  for (const f of ordered) {
    const src = join(SOURCE, f);
    const dst = join(DEST, f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    written.push(f);
    const a = sha256(src);
    const b = sha256(dst);
    if (a !== b) {
      die([
        `✗ ${f} failed the post-copy check (src ${a.slice(0, 8)}… vs dest ${b.slice(0, 8)}…)`,
        `  the run directory is now half-new half-old; do not launch it. written: ${written.join(', ')}. fix the cause and re-run.`,
      ]);
    }
    ok(`${f}  (${mb(statSync(dst).size)} MB)  ${a.slice(0, 8)}…`);
  }
} catch (e) {
  die([
    `✗ copy interrupted: ${e.code || ''} ${e.message}`,
    `  written: ${written.length > 0 ? written.join(', ') : '(none)'}; not written: ${ordered.filter((f) => !written.includes(f)).join(', ') || '(none)'}`,
    '  the run directory may be half-new half-old — quit the running FlowMic first, then re-run this command to finish it.',
  ]);
}

console.log('');
ok(`run copy updated → ${DEST}`);
info(`launch it: ${join(DEST, 'FlowMic.exe')}`);
info('the copy in publish/ is only an artifact waiting to be distributed; do not launch from there (RV-73).');
