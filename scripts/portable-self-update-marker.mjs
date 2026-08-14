// Card UP-9 — does the Windows portable zip we are about to publish actually
// CONTAIN the desktop's in-place self-update (swap) code?
//
// ── the hole this closes ────────────────────────────────────────────────────
//
// The portable edition's self-updater landed in commit 830bbf7 ("feat(desktop):
// the portable edition really replaces itself, and says so when it cannot"),
// committed 2026-08-08T07:32:29+08:00. The 0.2.59 portable artifact that was
// published that same day was built at 05:23 — roughly ninety minutes EARLIER.
// So the zip in ./publish carries an exe compiled from a tree that did not yet
// have the feature, and:
//
//   · publish.mjs's preflight was green (the exe existed, embedded the current
//     frontend, the sidecar carried its marker, versions matched);
//   · pack-portable.mjs was green (a well-formed zip, correct entries, correct
//     UTF-8 filename flags, sha256 sidecar written);
//   · verify:delivery was green;
//   · the update manifest happily pinned a sha256 for it.
//
// Nothing anywhere said the capability was missing. This is UP-7's shape moved
// one product across: not "we shipped something wrong" but "the capability does
// not exist and nobody knows". UP-7 gave the APK a byte gate
// (scripts/apk-self-update-marker.mjs); the desktop had none. This is that gate.
//
// 🔴 Note the difference in CAUSE, because it changes the refusal's advice. The
// APK's cause is a forgotten build-time define. The desktop's cause is a STALE
// EXE — a binary from an older tree packed into a current-version archive. The
// filename, the version stamp and the manifest all say 0.2.59; only the bytes
// disagree. So this gate's remedy line names a REBUILD, never a define.
//
// ── §measurement — what was actually measured, and what was not ─────────────
//
// 🔴 Read this section for what it does NOT claim. UP-7 could measure BOTH
// directions because two real release APKs could be built in minutes. Here only
// the NEGATIVE direction exists as real bytes today, and saying otherwise would
// be the「一句写错的机制解释，比没有解释更坏」shape CLAUDE.md records.
//
// MEASURED — negative direction, on already-shipped bytes.
//   Machine dev-pc-a, 2026-08-09. Subject:
//   publish/FlowMic-0.2.59-portable-windows-x64.zip, entry
//   `FlowMic-portable/FlowMic.exe` (15,825,408 bytes), inflated and scanned as
//   UTF-8:
//
//     marker                          hits    role
//     ------------------------------  ------  ---------------------------------
//     '--flowmic-apply-update'             0  FEATURE — absent, as predicted
//     'update-pending.json'                0  (corroborating second zero)
//     'inject:request'                     7  CONTROL — the scan is not blind
//     'FLOWMIC_LISTENING'                  3
//     'CalculateNativeWinOcclusion'        1
//     'INJECT_FOCUS_LOST'                  2
//     'flowmic-desktop'                    1
//
//   The same exe is what publish/FlowMic-portable/FlowMic.exe and the local run
//   copy (%LOCALAPPDATA%\Programs\FlowMic\FlowMic.exe) both are, byte count and
//   mtime identical — i.e. the shipped 0.2.59 desktop really does lack the swap
//   code, corroborated from the artifact rather than from anyone's recollection
//   of when they ran the build.
//
// 🔴 NOT MEASURED — positive direction. No binary built after 830bbf7 exists on
// this machine: apps/desktop/src-tauri/target/release/flowmic-desktop.exe is
// absent, and every FlowMic.exe on disk is the same pre-feature 15,825,408-byte
// 0.2.59 build. So "the marker is PRESENT when the code is there" has NOT been
// observed. It rests on two things, and they are of different strengths:
//
//   [measured]  Rust `&'static str` constants of exactly this kind DO survive
//               into the release exe. `inject:request` is declared
//               `pub const INJECT_REQUEST: &str` (src/events.rs:86) and scores 7
//               hits in the real 0.2.59 exe above. So the class of string this
//               gate looks for is demonstrably reachable by a UTF-8 byte scan.
//   [inferred]  APPLY_UPDATE_ARG (src/update/apply_arg.rs:47) is reachable from
//               `main()`: `intercept()` is called as the first statement of
//               `run()`, and it calls `job_path_from_args`, which compares argv
//               against this constant. It is live code, not dead code the
//               linker may drop. This is an argument, not a reading.
//
// ⇒ THE OBLIGATION THIS LEAVES OPEN, stated so it is not inherited silently:
//   the FIRST portable build made from a tree containing 830bbf7 is the
//   positive measurement. If this gate goes RED on a build that genuinely
//   contains the swap code, the conclusion is that the MARKER is wrong — not
//   that the build is. Re-measure and change the marker; do not weaken the gate
//   into something that cannot fail. Record the reading here when it is taken.
//
// ── 🔴 why the zip must be INFLATED, and why UP-7's approach cannot be copied ─
//
// UP-7 greps the APK's raw bytes, and that is legitimate there because Flutter
// stores lib/<abi>/libapp.so UNCOMPRESSED (measured: `unzip -v` says "Stored").
// The portable zip is the opposite, and this is measured, not assumed. Central
// directory of the 0.2.59 zip, same machine and date:
//
//     10 entries, no zip64
//     FlowMic-portable/FlowMic.exe → method 8 (DEFLATE)
//                                    csize 5,215,779 / usize 15,825,408
//
// A raw byte scan of that archive is therefore STRUCTURALLY BLIND: the exe's
// string constants do not exist as contiguous UTF-8 anywhere in the file. Worse
// than useless — it would score 0 on the feature marker AND 0 on the control
// marker for every portable zip ever built, correct ones included. So the entry
// is located through the central directory and inflated with
// zlib.inflateRawSync before a single marker is counted.
//
// ── 🔴 why this parses the zip in pure Node instead of shelling out ──────────
//
// `tar`/`unzip`/7z were all rejected. scripts/pack-portable.mjs's header records
// the measurement that settles it: on this machine `tar` resolves to TWO
// DIFFERENT PROGRAMS depending on which shell started the process — PowerShell
// finds bsdtar/libarchive, Git Bash finds GNU tar 1.35, which has no zip support
// at all and, handed a zip job, writes a TAR and EXITS 0. A release gate whose
// verdict depends on which terminal the operator opened is the very defect class
// this gate exists to remove. zlib is in the Node we already pin.
//
// ── why there is a CONTROL marker ───────────────────────────────────────────
//
// The control marker is `inject:request`: a protocol event name, present in
// every desktop build for structural reasons, whose only job is to prove the
// scan can see this exe's UTF-8 string constants AT ALL. CLAUDE.md's G13 rule
// ②:「负向断言必须自带正向对照，否则『零』可能是探针瞎了而不是实现对了」.
//
// Without it, the day the packer switches compression, or an exe gets packed
// UPX'd/signed-and-re-encoded, or the archive shape changes, this gate would
// report "you packed a stale exe" — confidently, and about the wrong thing —
// sending someone to rebuild a desktop that was already correct.
//
// Four outcomes, four diagnoses, four different actions. The ORDER is the
// contract: "I cannot see" must never be reported as "you forgot".
//   verdict 'no-exe-entry'    the archive has no FlowMic-portable/FlowMic.exe
//                             → not a FlowMic portable bundle, or the archive
//                               shape changed. Says nothing about any build.
//   verdict 'blind'           exe extracted, CONTROL absent → the SCAN is
//                             broken. Says NOTHING about the feature.
//   verdict 'missing-feature' control present, feature absent → the UP-9
//                             defect: a stale exe was packed.
//   verdict 'ok'              publish.
//
// ── no bypass flag, deliberately ────────────────────────────────────────────
//
// Matching publish.mjs's Gate 0 precedent verbatim, and UP-7's: no env
// override, no --force, no skip flag. If this gate ever has to be skipped, the
// honest way is to delete these lines in a commit where someone can see it.
//
// ── 🔴 KNOWN UNCOVERED SURFACE: macOS (and Linux) ───────────────────────────
//
// This gate covers the WINDOWS portable zip ONLY. It is stated here rather than
// left to be discovered because a gate's most dangerous property is implying
// coverage it does not have.
//
// The macOS portable zip (FlowMic-<v>-portable-macos-arm64.zip) is produced on a
// different machine and adopted into ./publish by scripts/adopt-artifact.mjs.
// Its archive shape is a `.app` bundle, so `FlowMic-portable/FlowMic.exe` does
// not exist in it and this checker would return 'no-exe-entry' — which is why
// publish.mjs applies it to the Windows zip alone rather than to every portable
// artifact. A macOS build packed from a stale tree is therefore STILL able to
// reach ./publish today, exactly the way 0.2.59's Windows zip did. Closing that
// needs its own marker (the macOS swap path is not this exe), its own control
// marker, and its own both-directions measurement on a real Mac artifact.
// Linux portable has no builder yet and the same statement applies to it.

import { inflateRawSync } from 'node:zlib';

import { countMarker } from './apk-self-update-marker.mjs';
import { PORTABLE_DIR_NAME } from './pack-portable.mjs';

/** One counting implementation for both gates. Re-exported rather than
 *  re-written: two hand-kept copies of one mechanism is the drift shape
 *  CLAUDE.md records for bump-version.mjs's FACES table. Occurrences are
 *  COUNTED, not tested for presence, because the count is the operator's
 *  evidence and lands in the log where a boolean would not. */
export { countMarker };

/** Present in EVERY desktop build whatever the tree. Its job is to prove the
 *  byte scan can see this exe's UTF-8 string constants at all — see the header.
 *  It is a protocol event name (`pub const INJECT_REQUEST` in
 *  src-tauri/src/events.rs, and packages/protocol/src/events.ts), so it cannot
 *  quietly drift out of the desktop while the protocol still carries it. */
export const PORTABLE_CONTROL_MARKER = 'inject:request';

/** Present ONLY when the in-place self-update (swap) code is compiled in. It is
 *  `APPLY_UPDATE_ARG` in src-tauri/src/update/apply_arg.rs — the argv the mover
 *  process is actually launched with, i.e. the thing the feature DOES, not a
 *  label describing it. A label could be renamed while the feature stayed;
 *  this string cannot change without changing how the mover is invoked. */
export const PORTABLE_SELF_UPDATE_MARKER = '--flowmic-apply-update';

/** The archive entry carrying the desktop binary. The directory half is
 *  IMPORTED from pack-portable.mjs rather than spelled again here: that module
 *  owns "the archive's single top-level entry", and one fact with two spellings
 *  is how the two drift apart. */
export const PORTABLE_EXE_ENTRY = `${PORTABLE_DIR_NAME}/FlowMic.exe`;

/** The command that produces a fresh desktop binary. Kept beside the marker so
 *  the refusal message and the docs quote one source rather than two. */
export const PORTABLE_BUILD_COMMAND = 'pnpm --filter @flowmic/desktop tauri:build';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
/** Max EOCD scan-back: 22-byte record + a 65,535-byte comment, the format's
 *  own ceiling. Bounded so a corrupt multi-hundred-MB file cannot turn into a
 *  full reverse scan of itself. */
const EOCD_MAX_BACK = 22 + 0xffff;

/**
 * Pull `FlowMic-portable/FlowMic.exe` out of a portable zip, inflating it.
 *
 * @param {Buffer} zipBuf
 * @returns {{exe: Buffer|null, reason: string|null, entries: string[]}}
 *
 * `exe` is null whenever the entry could not be produced, and `reason` then
 * names WHICH failure it was — the four causes are not interchangeable and a
 * single null would erase the difference between "this is a .app bundle" and
 * "this archive is corrupt". `entries` is always what was readable, because the
 * first thing an operator wants on a 'no-exe-entry' refusal is what the archive
 * DOES contain.
 *
 * Never throws on malformed input: a release gate that crashes produces a stack
 * trace where it owes a verdict.
 */
export function extractPortableExe(zipBuf) {
  const none = (reason, entries = []) => ({ exe: null, reason, entries });
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) return none('too-small-to-be-a-zip');

  // End of central directory, scanned backwards (the record is last, but a
  // trailing comment of arbitrary length may follow it).
  let eocd = -1;
  const floor = Math.max(0, zipBuf.length - EOCD_MAX_BACK);
  for (let i = zipBuf.length - 22; i >= floor; i--) {
    if (zipBuf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) return none('no-end-of-central-directory');

  const count = zipBuf.readUInt16LE(eocd + 10);
  const cdOff = zipBuf.readUInt32LE(eocd + 16);
  // zip64 sentinels. The 0.2.59 archive is not zip64 [measured] and at ~38 MB
  // could not be, but a future bundle could cross 4 GiB or 65,535 entries — and
  // when it does, these 32-bit fields hold 0xFFFF.../0xFFFFFFFF and reading them
  // as real values would walk into garbage and produce a CONFIDENT WRONG
  // verdict. Refusing by name is the honest outcome: it says the ruler does not
  // fit, rather than guessing.
  if (count === 0xffff || cdOff === 0xffffffff) return none('zip64-not-supported');
  if (cdOff >= zipBuf.length) return none('central-directory-offset-out-of-range');

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zipBuf.length || zipBuf.readUInt32LE(p) !== CD_SIG) {
      return none('central-directory-truncated', entries);
    }
    const method = zipBuf.readUInt16LE(p + 10);
    const csize = zipBuf.readUInt32LE(p + 20);
    const nlen = zipBuf.readUInt16LE(p + 28);
    const elen = zipBuf.readUInt16LE(p + 30);
    const clen = zipBuf.readUInt16LE(p + 32);
    const lho = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    entries.push(name);

    if (name === PORTABLE_EXE_ENTRY) {
      // The local header repeats the name/extra lengths and they may DIFFER from
      // the central directory's, so the payload offset must be computed from the
      // local header — a classic way to read a few bytes off and inflate garbage.
      if (lho + 30 > zipBuf.length) return none('local-header-out-of-range', entries);
      const lnlen = zipBuf.readUInt16LE(lho + 26);
      const lelen = zipBuf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnlen + lelen;
      if (start + csize > zipBuf.length) return none('entry-payload-out-of-range', entries);
      const raw = zipBuf.subarray(start, start + csize);
      if (method === 0) return { exe: raw, reason: null, entries };
      if (method !== 8) return none(`unsupported-compression-method-${method}`, entries);
      try {
        return { exe: inflateRawSync(raw), reason: null, entries };
      } catch (e) {
        return none(`inflate-failed:${e.code ?? e.message}`, entries);
      }
    }
    p += 46 + nlen + elen + clen;
  }
  return none('exe-entry-absent', entries);
}

/**
 * Scan a portable zip for the desktop's self-update feature.
 * @param {Buffer} zipBuf
 * @returns {{control:number, feature:number, exeBytes:number,
 *            verdict:'ok'|'missing-feature'|'blind'|'no-exe-entry',
 *            reason:string|null, entries:string[]}}
 *
 * 🔴 Order matters, twice over. 'no-exe-entry' is decided before anything is
 * counted (there is nothing to count), and 'blind' before 'missing-feature'.
 * A run where the scan cannot see anything must never be reported as "you
 * packed a stale exe" — that is a confident answer to a question this scan did
 * not manage to ask.
 */
export function scanPortableForSelfUpdate(zipBuf) {
  const { exe, reason, entries } = extractPortableExe(zipBuf);
  if (!exe) {
    return { control: 0, feature: 0, exeBytes: 0, verdict: 'no-exe-entry', reason, entries };
  }
  const control = countMarker(exe, PORTABLE_CONTROL_MARKER);
  const feature = countMarker(exe, PORTABLE_SELF_UPDATE_MARKER);
  const base = { control, feature, exeBytes: exe.length, reason: null, entries };
  if (control === 0) return { ...base, verdict: 'blind' };
  if (feature === 0) return { ...base, verdict: 'missing-feature' };
  return { ...base, verdict: 'ok' };
}

/** The refusal text for each non-ok verdict. Separated from publish.mjs so the
 *  drill can assert on the exact words an operator will read at 2am — the whole
 *  value of a red gate is that its message names the ACTION, and the three
 *  actions here are mutually exclusive. */
export function portableRefusalMessage(label, scan) {
  if (scan.verdict === 'no-exe-entry') {
    const listed = scan.entries.length > 0
      ? `Entries found: ${scan.entries.slice(0, 12).join(', ')}${scan.entries.length > 12 ? `, …(${scan.entries.length} total)` : ''}.`
      : 'No entries could be read at all.';
    return (
      `${label}: NOT A FLOWMIC WINDOWS PORTABLE BUNDLE — the archive has no ` +
      `'${PORTABLE_EXE_ENTRY}' entry (reason: ${scan.reason}). ${listed} ` +
      `This says NOTHING about any build: nothing was scanned. Either the wrong ` +
      `file was handed to this gate (the macOS portable zip is a .app bundle and ` +
      `will always land here — it is NOT covered by this check), or ` +
      `scripts/pack-portable.mjs's archive shape changed and this gate must be ` +
      `re-pointed before anyone touches the desktop build.`
    );
  }
  if (scan.verdict === 'blind') {
    return (
      `${label}: the feature scan is BLIND — the exe was extracted ` +
      `(${scan.exeBytes} bytes) but the control marker ` +
      `'${PORTABLE_CONTROL_MARKER}' is absent too (control=${scan.control}, ` +
      `feature=${scan.feature}). This says NOTHING about the self-update code. ` +
      `The bytes came out of the archive but do not read as a FlowMic desktop ` +
      `binary: wrong entry inflated, or the exe is now packed/encrypted/UPX'd so ` +
      `a UTF-8 byte scan can no longer reach its string constants. ` +
      `Re-measure the scan before touching the build — do NOT rebuild the desktop ` +
      `on the strength of this message.`
    );
  }
  return (
    `${label}: packed a desktop exe WITHOUT the in-place self-update (swap) ` +
    `code — marker '${PORTABLE_SELF_UPDATE_MARKER}' absent from ` +
    `${PORTABLE_EXE_ENTRY} (${scan.exeBytes} bytes; control marker present: ` +
    `${scan.control} hits, so the scan CAN read this exe's strings). This is a ` +
    `STALE BINARY, not a build flag: the exe was compiled from a tree older than ` +
    `the portable self-updater (commit 830bbf7), while the filename, the version ` +
    `stamp and the manifest all claim the current version. That is exactly how ` +
    `0.2.59 shipped a portable edition that cannot update itself. ` +
    `Rebuild the desktop, then re-run publish:  ${PORTABLE_BUILD_COMMAND}`
  );
}
