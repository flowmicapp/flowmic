// Card MSI-OFFLINE-WEBVIEW2 — build the Microsoft Store variant of the Windows
// MSI, on demand only.
//
//   pnpm --filter @flowmic/desktop tauri:build:store
//
// WHAT IT PRODUCES
//   apps/desktop/src-tauri/target/release/bundle/msi-store/
//     FlowMic_<version>_x64_en-US_store.msi          (+ .sha256, sha256sum format)
//   Offline WebView2 (Microsoft's Evergreen Standalone Installer embedded, run
//   with /silent /install only when no runtime is registered), signed like
//   every Windows artifact. ~252 MiB against the direct MSI's ~47 MiB.
//
// WHY ONLY en-US
//   Partner Center takes one versioned URL per package and asks which
//   languages the PACKAGE supports (learn.microsoft.com/windows/apps/publish/
//   publish-your-app/msi/upload-app-packages, read 2026-10-27); the Store runs
//   an MSI with /qn, so the installer's own dialogs — the only thing that
//   differs between our en-US and zh-CN MSIs — are never shown. The app inside
//   is the same nine-language app in both (its UI language is a setting, not
//   the installer's). One package declared with the app's languages covers it.
//   tauri.store.conf.json therefore sets wix.language to ["en-US"]: half the
//   build time and half the 252 MiB.
//
// WHY THIS CANNOT RUN BY ACCIDENT OR CLOBBER THE DIRECT BUILD
//   · Tauri merges tauri.conf.json + tauri.windows.conf.json on every build;
//     tauri.store.conf.json is merged ONLY when passed with --config, and only
//     this script passes it. `pnpm ship` and plain tauri:build never do.
//   · Tauri writes both variants to the same bundle/msi folder under the same
//     names. Before building, this script moves this version's direct MSIs and
//     the direct exe aside (bundle/.msi-direct-hold/), and afterwards — success
//     or failure — removes what the store build left in bundle/msi and puts the
//     direct files back. bundle/msi never keeps a store MSI; if one ever gets
//     there anyway, publish.mjs (msiVariant 'direct') refuses it by content.
//   · The output name carries the version and `_store`; an existing file of
//     that name is never overwritten (a submitted Store binary must not change —
//     delete it yourself only if it was never submitted).
//   · Every reader of the product update path refuses `*_store.msi`
//     (pack-portable.mjs isStoreMsiName), and the file is written outside
//     ./publish, which is the only folder those readers list.
//
// GATES
//   The build is the normal tauri:build chain (signer preflight, resource
//   signing, Tauri signCommand, exe re-sign, verify-bundle) with --config
//   added; then the IT-19 signature gate with msiVariant 'store', which also
//   requires the MSI to be offline + silent (scripts/msi-webview2-offline.mjs).
//   A refusal produces no output file.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from './module-entrypoint-guard.mjs';
import { storeMsiName } from './pack-portable.mjs';
import { verifyWindowsArtifactsSigned } from './windows-signature-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const TAURI = join(DESKTOP, 'src-tauri');
const RELEASE = join(TAURI, 'target', 'release');
const BUNDLE = join(RELEASE, 'bundle', 'msi');
export const STORE_MSI_DIR = join(RELEASE, 'bundle', 'msi-store');
const HOLD = join(RELEASE, 'bundle', '.msi-direct-hold');
const EXE = join(RELEASE, 'flowmic-desktop.exe');
export const STORE_CONFIG = join(TAURI, 'tauri.store.conf.json');
const TAURI_BUILD = 'tauri build --features app';

/** The store chain = the desktop package's own tauri:build string with
 *  `--config <store conf>` added to the tauri invocation — one source for the
 *  chain, so the two variants cannot drift apart in anything but that flag. */
export function storeBuildChain(tauriBuildScript, configPath = STORE_CONFIG) {
  const n = tauriBuildScript.split(TAURI_BUILD).length - 1;
  if (n !== 1) throw new Error(`expected "${TAURI_BUILD}" exactly once in the desktop tauri:build script, found ${n}`);
  return tauriBuildScript.replace(TAURI_BUILD, `${TAURI_BUILD} --config "${configPath}"`);
}

export function storeLanguages(config) {
  const langs = config?.bundle?.windows?.wix?.language;
  if (!Array.isArray(langs) || langs.length === 0) throw new Error('tauri.store.conf.json must list bundle.windows.wix.language explicitly');
  return langs;
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const fail = (m) => console.error(`  ✗ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

function main() {
  if (process.platform !== 'win32') { console.error('the Store MSI is a Windows artifact; run this on Windows.'); return 1; }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const langs = storeLanguages(JSON.parse(readFileSync(STORE_CONFIG, 'utf8')));
  const thisVersion = (f) => f.endsWith('.msi') && f.includes(version);

  if (existsSync(HOLD) && readdirSync(HOLD).length > 0) {
    console.error(`✗ ${HOLD} is not empty: an earlier store build stopped before putting the direct build back.\n` +
      `  Move its .msi files back into ${BUNDLE} and its flowmic-desktop.exe back into ${RELEASE}, delete the folder, then re-run.`);
    return 1;
  }
  const outputs = langs.map((lang) => ({ lang, built: join(BUNDLE, `FlowMic_${version}_x64_${lang}.msi`), dest: join(STORE_MSI_DIR, storeMsiName(version, lang)) }));
  for (const o of outputs) {
    if (existsSync(o.dest)) {
      console.error(`✗ ${o.dest} already exists. A Store binary must not change once submitted, so it is never overwritten.\n` +
        '  Delete it yourself only if it was never submitted to Partner Center.');
      return 1;
    }
  }
  const chain = storeBuildChain(JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).scripts['tauri:build']);

  mkdirSync(HOLD, { recursive: true });
  const held = existsSync(BUNDLE) ? readdirSync(BUNDLE).filter(thisVersion) : [];
  for (const f of held) renameSync(join(BUNDLE, f), join(HOLD, f));
  const heldExe = existsSync(EXE);
  if (heldExe) copyFileSync(EXE, join(HOLD, 'flowmic-desktop.exe'));
  console.log(`[store-msi] direct build set aside: ${held.length} MSI(s)${heldExe ? ' + flowmic-desktop.exe' : ''} → ${HOLD}`);

  let code = 1;
  try {
    console.log(`[store-msi] ${chain}`);
    const env = { ...process.env, PATH: `${join(DESKTOP, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}` };
    const r = spawnSync(chain, { cwd: DESKTOP, shell: true, stdio: 'inherit', env });
    if (r.status !== 0) { console.error(`✗ the store build failed (exit ${r.status}); nothing was written to ${STORE_MSI_DIR}`); return 1; }
    const missing = outputs.filter((o) => !existsSync(o.built));
    if (missing.length > 0) { console.error(`✗ the build did not produce ${missing.map((o) => o.built).join(', ')}`); return 1; }
    const good = verifyWindowsArtifactsSigned({
      msis: outputs.map((o) => o.built),
      msiVariant: 'store',
      scratchRoot: join(ROOT, '.local', 'windows-signature-gate'),
      fail, ok,
    });
    if (!good) { console.error(`✗ the store MSI was refused by the gate above; nothing was written to ${STORE_MSI_DIR}`); return 1; }
    mkdirSync(STORE_MSI_DIR, { recursive: true });
    for (const o of outputs) {
      copyFileSync(o.built, o.dest);
      const h = sha256(o.dest);
      writeFileSync(`${o.dest}.sha256`, `${h}  ${storeMsiName(version, o.lang)}\n`);
      console.log(`[store-msi] wrote ${o.dest} (${statSync(o.dest).size} bytes, sha256 ${h})`);
    }
    code = 0;
    return 0;
  } finally {
    for (const f of existsSync(BUNDLE) ? readdirSync(BUNDLE).filter(thisVersion) : []) rmSync(join(BUNDLE, f), { force: true });
    mkdirSync(BUNDLE, { recursive: true });
    for (const f of held) renameSync(join(HOLD, f), join(BUNDLE, f));
    if (heldExe) copyFileSync(join(HOLD, 'flowmic-desktop.exe'), EXE);
    rmSync(HOLD, { recursive: true, force: true });
    console.log(`[store-msi] direct build restored (${held.length} MSI(s)${heldExe ? ' + exe' : ''}); bundle/msi holds no store MSI${code === 0 ? '' : ' (build or gate failed)'}`);
  }
}

if (isDirectRun(import.meta.url)) process.exit(main());
