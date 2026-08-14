// The portable-archive step of scripts/publish.mjs: pack the one-click bundle
// into a distributable zip (card UP-1), then refuse it if the exe inside does
// not carry the in-place self-updater (card UP-9).
//
// ── why this is its own file ────────────────────────────────────────────────
//
// Not a preference. scripts/publish.mjs was at 798 lines against verify:lint's
// 800-line cap — two lines of headroom — so the UP-9 gate physically could not
// be added inline, and the repo's rule for that situation is explicit: 「按仓里
// 成例做结构拆分而不是删证据」(CLAUDE.md, recorded when 0.2.52 pushed two files
// over the same cap). Every comment moved here is VERBATIM; nothing was
// shortened to buy room.
//
// The two halves belong together: packing produces the artifact and the gate
// decides whether that artifact may leave the building. Splitting them across
// files would put the producer and its only acceptance test in two places.
//
// ⚠️ Both halves EXIT rather than returning a status — see gatePortableArchive's
// own note for why that is load-bearing rather than lazy.

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { portableZipName } from './pack-portable.mjs';
import {
  PORTABLE_SELF_UPDATE_MARKER,
  portableRefusalMessage,
  scanPortableForSelfUpdate,
} from './portable-self-update-marker.mjs';

/**
 * Stage the sherpa addon into the portable bundle (card ENG-1b, 2026-08-13 —
 * the distribution half of ENG-1/fix-028; NOT ENG-2, which is the engine-code
 * overwrite card).
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * Commit a9884ca (fix-028) made `build-sidecar.mjs` stage the addon under
 * `src-tauri/resources/node_modules/` and tightened BOTH consumers —
 * `install-local.mjs` REQUIRED_FILES and `update/swap.rs` REQUIRED_STAGED_FILES
 * name the glue's package.json and the native `.node` binary — but neither
 * DISTRIBUTION producer was touched. publish.mjs copied exactly three files
 * into the portable resources dir, so every shipped portable zip:
 *   · cannot open the engine the stock seed points at (defaults.ts seeds
 *     `builtin-sherpa-local` for `zh` AND `*` — first utterance dies), and
 *   · is REFUSED by the 0.2.62+ in-place updater's own sanity check
 *     (StagedTreeIncomplete), so portable self-update 0.2.62 → next is dead
 *     until the zip carries what swap.rs demands.
 * install-local.mjs's refusal even said "re-run publish.mjs" — advice that
 * could never help while publish.mjs had no code path that copies node_modules.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 * Flat siblings under `resources/node_modules/`, copied FROM the tree
 * build-sidecar.mjs staged (same source the MSI bundles) — one answer to
 * "which addon ships", not a second resolve that merely agrees today. The
 * platform mapping (win32 → `win`) mirrors the vendor's own addon.js, same as
 * stageSherpaAddon() and verify-sherpa-sidecar-addon.mjs — not re-invented.
 *
 * Refuses rather than half-stages: glue without the native half is the shape
 * fix-028 exists to kill, one directory further downstream.
 *
 * @param {{tauriResources:string, portableDir:string,
 *          fail:(m:string)=>void, ok:(m:string)=>void}} io
 * @returns {boolean} true when both packages are staged
 */
export function stagePortableSherpaAddon({ tauriResources, portableDir, fail, ok }) {
  const glue = 'sherpa-onnx-node';
  const nativePkg = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const srcModules = join(tauriResources, 'node_modules');
  const glueSrc = join(srcModules, glue);
  const nativeSrc = join(srcModules, nativePkg);
  // The NATIVE BINARY is the existence question, not the directory — a
  // half-staged dir "exists" exactly as confidently (install-local.mjs makes
  // this argument in as many words beside its REQUIRED_FILES list).
  const nativeBinary = join(nativeSrc, 'sherpa-onnx.node');
  if (!existsSync(join(glueSrc, 'package.json')) || !existsSync(nativeBinary)) {
    fail(
      `staged sherpa addon incomplete under ${srcModules} — run \`pnpm --filter @flowmic/desktop build:sidecar\` first.\n` +
        `    The stock STT seed is builtin-sherpa-local (server-core settings/defaults.ts), and the in-place\n` +
        '    updater (update/swap.rs) refuses a staged tree without the addon — a portable bundle without it\n' +
        '    is the exact 0.2.61 incident fix-028 closed at the staging layer, re-shipped from this one.',
    );
    return false;
  }
  const destModules = join(portableDir, 'resources', 'node_modules');
  let bytes = 0;
  for (const [name, src] of [[glue, glueSrc], [nativePkg, nativeSrc]]) {
    const dest = join(destModules, name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    for (const e of readdirSync(dest, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) bytes += statSync(join(e.parentPath ?? e.path, e.name)).size;
    }
  }
  ok(`resources/node_modules/{${glue},${nativePkg}}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}

/**
 * GATE: the packed exe really carries the self-update code (card UP-9).
 *
 * The packer answers "is this a well-formed archive of the staged bundle?". It
 * cannot answer "does the exe inside it CONTAIN the in-place updater?" — a stale
 * binary packs into a perfectly valid zip, under a filename carrying the current
 * version, and hashes into the manifest without a murmur. That is precisely how
 * 0.2.59 shipped a portable edition that cannot update itself: the exe was built
 * ~90 minutes before commit 830bbf7 landed, and every gate in this repo stayed
 * green.
 *
 * So this asks the payload, the same way publish.mjs's APK block and its
 * exe/sidecar marker block do. The both-directions accounting (and, honestly,
 * which direction is measured and which is not), the DEFLATE inflation, the
 * control-marker rationale, the deliberate absence of a bypass flag, and the
 * KNOWN macOS gap all live in the helper's header:
 * scripts/portable-self-update-marker.mjs.
 *
 * 🔴 WHY THIS EXITS RATHER THAN JUST CALLING fail(). Everywhere earlier in
 * publish.mjs, fail() is sufficient because an `if (failed) process.exit(1)`
 * follows it. This step runs AFTER the last such check, so a bare fail() here
 * would print a red line, set a flag nobody reads again, and let the run
 * continue into the download-center upload — publishing the very artifact it
 * just refused. fail() is still called, so the message is formatted and reported
 * identically to every other refusal; the exit is what makes the refusal real. A
 * gate that prints and continues is the façade shape this repo names as its
 * headline historical bug class.
 *
 * `exit` is a PARAMETER, defaulting to the real thing, for the reason
 * apply_arg.rs's `spawn_mover` takes `source_exe`: a function that can only end
 * the process can only be exercised by ending the process. The UP-9 drill drives
 * this exact function against the real shipped 0.2.59 zip and asserts that it
 * both refuses AND exits — which is a measurement of the wiring, not a regex
 * over its source text.
 *
 * @param {{outDir:string, version:string, fail:(m:string)=>void,
 *          ok:(m:string)=>void, exit?:(code:number)=>void,
 *          err?:(m:string)=>void}} io
 */
export function gatePortableArchive({ outDir, version, fail, ok, exit = process.exit, err = console.error }) {
  const zipName = portableZipName(version);
  const portableZip = join(outDir, zipName);
  if (!existsSync(portableZip)) {
    fail(`packer reported success but ${zipName} is not in ./publish — refusing to publish.`);
    return exit(1);
  }
  const scan = scanPortableForSelfUpdate(readFileSync(portableZip));
  if (scan.verdict !== 'ok') {
    fail(portableRefusalMessage(zipName, scan));
    err('\n✗ publish FAILED — the portable archive was written to ./publish but must NOT be distributed.');
    err('  Nothing has been uploaded to the download center.');
    return exit(1);
  }
  ok(
    `${zipName} carries the desktop self-update feature ` +
      `('${PORTABLE_SELF_UPDATE_MARKER}' ×${scan.feature}; control ×${scan.control}; ` +
      `exe ${scan.exeBytes} bytes)`
  );
  return scan;
}

/**
 * The portable bundle, as a FILE (card UP-1), then gated (card UP-9).
 *
 * Runs only after every preflight in publish.mjs is green, so a bundle that was
 * about to be refused never gets packed — and BEFORE the download-center step,
 * so the zip and its sidecar already exist when the uploader collects artifacts.
 * That ordering is the whole wiring: it makes "the portable ships too" a
 * call-order fact instead of a step someone has to remember.
 *
 * Until this existed, FlowMic-portable/ was the one product this chain builds
 * and never distributes — it is a directory, and every downstream consumer
 * (upload, manifest) deals in single files. The S8 audit measured that it had
 * never once reached the download center.
 *
 * Hard failure, deliberately, with no skip path: a release that silently lacks
 * the portable download is exactly the shape that audit found, and "we shipped
 * without it and nobody noticed" is the outcome being bought off here.
 */
export function publishPortableArchive({ root, outDir, version, fail, ok, exit = process.exit }) {
  console.log('\n── portable archive (card UP-1) ──');
  const packer = spawnSync(process.execPath, [join(root, 'scripts', 'pack-portable.mjs')], { cwd: root, stdio: 'inherit' });
  if (packer.error) {
    console.error(`✗ could not run scripts/pack-portable.mjs: ${packer.error.message}`);
    return exit(1);
  }
  if (packer.status !== 0) {
    console.error(`✗ packing the portable bundle FAILED (exit ${packer.status}) — refusing to publish.`);
    console.error('  ./publish is staged and correct; fix the packer and re-run, or run');
    console.error('  `node scripts/pack-portable.mjs` alone once the cause is fixed.');
    return exit(1);
  }
  return gatePortableArchive({ outDir, version, fail, ok, exit });
}
