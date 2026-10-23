#!/usr/bin/env node
// scripts/build-stamp/verify-built-artifact.mjs — card NR-170.
//
// Build-time half of the commit stamp: the LAST line of `make release`,
// `make release-store` and `make release-ios`. It reads the artifact the build
// just wrote and refuses (exit 1) unless every compiled Dart library inside it
// carries the stamp of THIS tree's commit.
//
// ── THE INCIDENT (0.3.107, 2026-10-07, measured; ledger row NR-170) ─────────
//
// A reused slot built an APK whose three `lib/<abi>/libapp.so` carried the
// stamp of a build from two days earlier, and LACKED a string that is newer
// than that commit. `make -C apps/mobile release` exited 0 and printed no
// warning: the fresh `intermediates/flutter/directRelease/jniLibs/*/libapp.so`
// were correct, but Gradle packaged `merged_jni_libs/directRelease` and
// `stripped_native_libs/directRelease` left over from the old build. Only
// scripts/publish.mjs GATE 0f (publish time, direct APK only) noticed.
//
// Two holes that GATE 0f leaves open, and why a second reader exists:
//   1. It only runs at publish. Card self-tests, device installs and emulator
//      runs use the `make` output, so old Dart code gets tested as new code.
//   2. The Play bundle carries no stamp and never passes through publish.mjs,
//      so the same stale bytes would travel all the way to the store console
//      with nothing to object.
//
// ── WHAT IS READ, AND WHY NOT THE WHOLE FILE ────────────────────────────────
//
//   apk / aab   every `lib/<abi>/libapp.so` (an AAB: `<module>/lib/<abi>/...`),
//               each inflated by the zip reader store-channel-gate.mjs already
//               uses. A raw scan of an AAB is BLIND (entries are deflated), and
//               a raw scan of an APK would collapse three ABIs into one verdict
//               — one stale ABI among fresh ones is exactly the shape to catch.
//   ipa         `Payload/*.app/Frameworks/App.framework/App`, the AOT snapshot.
//
// The stamp prefix, the control marker and the four-way verdict (ok / blind /
// unstamped / mismatch) are IMPORTED from artifact-sha-gate.mjs, so the
// publish gate and this build-time check cannot disagree about what a good
// artifact looks like.
//
// 🔴 STATED LIMIT, IPA: the ipa path is written against the layout of a Flutter
// iOS archive and drilled on synthetic zips only; it has not been run against a
// real `flutter build ipa` output on this machine (Windows). A BLIND verdict on
// the first real Mac run means the scan cannot read that snapshot — re-measure
// before touching the build, exactly as the message says.
//
// 🔴 WHAT THIS DOES NOT PROVE: that the Dart code is the code you meant to test
// in other languages' layers (Kotlin/Java classes, resources). It proves the
// Dart AOT payload — the part that went stale — is from this commit.
//
// Usage:  node scripts/build-stamp/verify-built-artifact.mjs --kind apk|aab|ipa <path>
// Exit 0 = every library carries this tree's stamp. Exit 1 = it does not
// (or the scan could not be run). Exit 2 = bad usage.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inflateZipEntry, zipEntries } from '../store-channel-gate.mjs';
import { APK_CONTROL_MARKER, scanArtifactForSha } from './artifact-sha-gate.mjs';
import { resolveBuildSha } from './require-clean-sha.mjs';

/** Which zip entries are the compiled Dart payload, per artifact kind. */
export const PAYLOAD_ENTRY = {
  apk: /^lib\/[^/]+\/libapp\.so$/,
  aab: /^[^/]+\/lib\/[^/]+\/libapp\.so$/,
  ipa: /^Payload\/[^/]+\.app\/Frameworks\/App\.framework\/App$/,
};

/** Gradle intermediates the 0.3.107 incident measured as the stale source. */
export const STALE_PRONE_DIRS =
  'apps/mobile/build/app/intermediates/{merged_jni_libs,merged_native_libs,stripped_native_libs}/<variant>';

export const REBUILD_COMMAND = {
  apk: 'make -C apps/mobile release',
  aab: 'make -C apps/mobile release-store',
  ipa: 'make -C apps/mobile release-ios',
};

/**
 * Judge one artifact's bytes against the stamp value this tree produces.
 *
 * @param {Buffer} buf
 * @param {'apk'|'aab'|'ipa'} kind
 * @param {string} expected — the value resolveBuildSha() returns for this tree
 * @returns {{ok:boolean, libs:{name:string, verdict:string, values:string[]}[], problems:string[]}}
 */
export function judgeBuiltArtifact(buf, kind, expected) {
  const pattern = PAYLOAD_ENTRY[kind];
  if (!pattern) return { ok: false, libs: [], problems: [`unknown artifact kind '${kind}'`] };
  let entries;
  try {
    entries = zipEntries(buf);
  } catch (e) {
    return { ok: false, libs: [], problems: [`cannot read the ${kind} as a zip: ${e.message}`] };
  }
  const payload = entries.filter((e) => pattern.test(e.name));
  if (payload.length === 0) {
    // A scan that found nothing to scan is a BLIND scan, never a pass.
    return {
      ok: false,
      libs: [],
      problems: [
        `no compiled Dart library matching ${pattern} inside the ${kind} ` +
          `(${entries.length} entries). Nothing was checked, so nothing is vouched for.`,
      ],
    };
  }
  const libs = [];
  const problems = [];
  for (const e of payload) {
    const scan = scanArtifactForSha(inflateZipEntry(buf, e), APK_CONTROL_MARKER, expected);
    libs.push({ name: e.name, verdict: scan.verdict, values: scan.values });
    if (scan.verdict === 'ok') continue;
    if (scan.verdict === 'blind') {
      problems.push(
        `${e.name}: the scan is BLIND (control '${APK_CONTROL_MARKER}' absent, so this says nothing ` +
          'about which commit built it) - re-measure the scanner, do not just rebuild.',
      );
    } else if (scan.verdict === 'unstamped') {
      problems.push(`${e.name}: carries NO build sha - it was built without the stamping define.`);
    } else {
      problems.push(
        `${e.name}: stamped ${scan.values.join(', ')} but this tree is ${expected}. ` +
          'Stale Dart code from an earlier build was packaged.',
      );
    }
  }
  return { ok: problems.length === 0, libs, problems };
}

export function main(argv, { resolveSha = resolveBuildSha, out = console } = {}) {
  const kindIx = argv.indexOf('--kind');
  const kind = kindIx >= 0 ? argv[kindIx + 1] : undefined;
  const path = argv.filter((a, i) => !a.startsWith('--') && i !== kindIx + 1)[0];
  if (!kind || !PAYLOAD_ENTRY[kind] || !path) {
    out.error('usage: node scripts/build-stamp/verify-built-artifact.mjs --kind apk|aab|ipa <path>');
    return 2;
  }
  let expected;
  try {
    expected = resolveSha().value;
  } catch (e) {
    out.error(`x cannot say which commit this tree is, so the ${kind} cannot be checked:\n  ${e.message}`);
    return 1;
  }
  // A missing artifact is a failure, never a skip. A directory is accepted for
  // the one case where the file name is not ours to choose: `flutter build ipa`
  // names the .ipa after the app, so the Makefile passes build/ios/ipa and this
  // picks the single .ipa inside (zero or several is a failure, not a guess).
  if (!existsSync(path)) {
    out.error(`x ${path} does not exist - the build did not produce the artifact this check reads.`);
    return 1;
  }
  let file = path;
  if (statSync(path).isDirectory()) {
    const found = readdirSync(path).filter((n) => n.endsWith(`.${kind}`));
    if (found.length !== 1) {
      out.error(`x ${path} holds ${found.length} .${kind} files; expected exactly one (${found.join(', ') || 'none'}).`);
      return 1;
    }
    file = resolve(path, found[0]);
  }
  const verdict = judgeBuiltArtifact(readFileSync(file), kind, expected);
  if (verdict.ok) {
    out.log(
      `OK ${file}: ${verdict.libs.length} compiled Dart librar${verdict.libs.length === 1 ? 'y' : 'ies'} ` +
        `all carry the stamp of ${expected.slice(0, 12)}...`,
    );
    return 0;
  }
  out.error(`FAIL ${file} was NOT built from this tree (${expected}):`);
  for (const p of verdict.problems) out.error(`  - ${p}`);
  out.error(
    `  The build exited 0 on its own; this check is the reason it does not any more.\n` +
      `  Known cause (0.3.107): Gradle reused old intermediates. Delete\n    ${STALE_PRONE_DIRS}\n` +
      `  for the variant you built, then rerun:  ${REBUILD_COMMAND[kind]}`,
  );
  return 1;
}

const thisFile = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? resolve(process.argv[1]) : null;
const canon = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (argvEntry && normalize(canon(thisFile)) === normalize(canon(argvEntry))) {
  process.exit(main(process.argv.slice(2)));
}
