#!/usr/bin/env node
// Card IT-19 — sign Windows build outputs with the owner's Certum certificate.
//
// WHO RUNS THIS: Tauri, through three hooks that exist ONLY in
// apps/desktop/src-tauri/tauri.windows.conf.json (Tauri merges that file on
// Windows builds and never reads it on macOS/Linux):
//
//   build.beforeBuildCommand    `--check`               fail before the compile, not after it,
//                                                       when the key is unreachable (it opens
//                                                       the key; a dead SimplySign session is
//                                                       refused after keyProbeTimeoutMs, 20 s);
//   build.beforeBundleCommand   `--resources <dir>`     the staged sidecar payload, which WiX
//                                                       and publish.mjs both read from
//                                                       src-tauri/resources at bundle time;
//   bundle.windows.signCommand  `<file>` (Tauri's %1)   the main exe and each MSI (Tauri also
//                                                       passes two WiX build-tool DLLs; those
//                                                       are declined, see isFlowMicSignTarget).
//
// Measured working directories (tauri-cli 2.11.4): the two build hooks run in
// apps/desktop, signCommand runs in apps/desktop/src-tauri — hence the
// different `../` depth in the config. A wrong depth fails the build with
// "Cannot find module", it cannot pass silently.
//
// …plus one step outside Tauri, in apps/desktop/package.json `tauri:build`:
//
//   `--after-tauri-build`   re-signs target/release/flowmic-desktop.exe, which Tauri
//                           leaves unsigned after bundling (see below); no-op off Windows.
//
//   node scripts/sign-windows.mjs --check
//   node scripts/sign-windows.mjs --resources apps/desktop/src-tauri/resources
//   node scripts/sign-windows.mjs <file> [<file>...]
//
// Rule for every file: a PE that already carries a valid, chained, TIMESTAMPED
// signature is kept as it is (node.exe ships with the OpenJS Foundation's, and
// re-signing it would change the bytes scripts/vendor/bundled-node.mjs pins);
// anything else is signed with our certificate and a timestamp, then
// re-verified. There is no "sign without a timestamp" path.
//
// OPT-OUT: FLOWMIC_WINDOWS_SIGN=off makes every mode print an UNSIGNED banner
// and exit 0. That is the only way to build unsigned on Windows, and the result
// cannot be published: scripts/windows-signature-gate.mjs refuses it at
// publish.mjs and adopt-artifact.mjs. `tauri build --no-sign` alone is NOT the
// opt-out — it skips Tauri's signCommand but not the two build hooks above.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGNTOOL_MISSING,
  classifySignature,
  isFlowMicSignTarget,
  listPeFiles,
  preflightSigner,
  signFile,
  signingConfig,
  signingMode,
  unsignedBanner,
  verifyWithSigntool,
} from './windows-signing.mjs';

const say = (m) => console.log(`[sign-windows] ${m}`);
const die = (m) => {
  console.error(`[sign-windows] ✗ ${m}`);
  process.exit(1);
};

const argv = process.argv.slice(2);

// `--after-tauri-build`: the last signing step, run from apps/desktop's
// tauri:build script on every platform. 🔴 [measured 2026-10-26, tauri-cli
// 2.11.4] Tauri signs target/release/flowmic-desktop.exe before WiX packs it,
// then RESTORES the unsigned binary once bundling ends (the exe left in
// target/ differed from the MSI's copy in exactly the checksum and
// certificate-directory header bytes, and verified "No signature found").
// The MSI is fine; the portable bundle, which publish.mjs copies from
// target/, would ship unsigned. So the exe is signed once more here, after
// Tauri is done with it. Off Windows there is no Authenticode step at all.
if (argv[0] === '--after-tauri-build') {
  if (process.platform !== 'win32') {
    console.log(`[sign-windows] ${process.platform}: no Authenticode step on this platform`);
    process.exit(0);
  }
  argv.splice(0, 1, join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'src-tauri', 'target', 'release', 'flowmic-desktop.exe'));
}
const check = argv.includes('--check');
const resIdx = argv.indexOf('--resources');
const files = argv.filter((a, i) => !a.startsWith('--') && !(resIdx !== -1 && i === resIdx + 1));
const what = check ? 'anything (--check)' : resIdx !== -1 ? `the staged resources in ${argv[resIdx + 1]}` : files.join(', ');

let mode;
try { mode = signingMode(); } catch (e) { die(e.message); }
if (mode === 'off') {
  console.log(unsignedBanner(what));
  process.exit(0);
}
if (!check && resIdx === -1 && files.length === 0) die('nothing to sign — usage: sign-windows.mjs --check | --resources <dir> | <file>...');
if (resIdx !== -1 && !argv[resIdx + 1]) die('--resources needs a directory');

let config;
try { config = signingConfig(); } catch (e) { die(e.message); }
const pre = preflightSigner(config);
if (!pre.ok) {
  die(`cannot sign (${pre.problem}): ${pre.message}`);
}
say(`${pre.message} (cwd ${process.cwd()})`);
if (check) process.exit(0);

const signtool = pre.signtool?.path;
if (!signtool) die(SIGNTOOL_MISSING);

const targets = resIdx !== -1 ? listPeFiles(resolve(argv[resIdx + 1])) : files.map((f) => resolve(f));
if (resIdx !== -1 && targets.length === 0) die(`no PE file under ${argv[resIdx + 1]} — the staged payload is missing (run build-sidecar first), refusing to report "nothing to sign" as success`);

let failed = 0;
for (const file of targets) {
  if (resIdx === -1 && !isFlowMicSignTarget(file)) {
    say(`declined ${file} — not a FlowMic artifact (Tauri also asks for its WiX build-tool copies; they never ship)`);
    continue;
  }
  const before = verifyWithSigntool(signtool, file);
  const verdict = classifySignature(before);
  if (verdict === 'ok') {
    const ours = before.leafSha1 === config.thumbprint;
    say(`kept   ${file} — already signed and timestamped (${ours ? 'our certificate' : `third-party signer ${before.leafSha1}`})`);
    continue;
  }
  const r = signFile(signtool, file, config);
  if (r.ok) {
    say(`signed ${file} — was ${verdict}; timestamp ${r.url}`);
    continue;
  }
  failed += 1;
  const tail = r.attempts.map((a) => `      ${a.url}: ${a.text.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ')}`).join('\n');
  if (r.kind === 'timestamp') {
    console.error(`[sign-windows] ✗ ${file}: every timestamp authority failed; NOT leaving it signed without a timestamp.\n${tail}\n      Check the network, or set FLOWMIC_SIGN_TIMESTAMP_URLS to a reachable RFC 3161 authority.`);
  } else if (r.kind === 'key') {
    console.error(`[sign-windows] ✗ ${file}: the private key refused to sign — SimplySign Desktop is probably logged out or its session expired.\n${tail}\n      Log in to SimplySign Desktop again and re-run the build.`);
  } else {
    console.error(`[sign-windows] ✗ ${file}: signing failed.\n${tail}`);
  }
}
if (failed > 0) die(`${failed} of ${targets.length} file(s) not signed`);
say(`done: ${targets.length} file(s) carry a valid, timestamped signature`);
