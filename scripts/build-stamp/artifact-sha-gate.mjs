// scripts/build-stamp/artifact-sha-gate.mjs — the reader half of card SC-5,
// used by scripts/publish.mjs as GATE 0f.
//
// ── THE QUESTION ────────────────────────────────────────────────────────────
//
// "Were these bytes built from the commit the gate receipt names?"
//
// Nothing could answer it before. `pnpm verify:delivery` proves a TREE is good
// and writes a receipt naming its sha (scripts/gate-receipt.mjs); publish then
// staged whatever exe and APK happened to be on disk. In the sequential chain
// those were usually the same commit by accident of ordering. The eight-minute
// chain removes that accident on purpose — builds start at t=0, in parallel
// with the gate, on warm trees — so "the artifact is one commit behind" becomes
// a state that occurs, and one that looks exactly like a correct round. It is
// risk R1 of docs/strategy/2026-09-17-ship-chain-eight-minute-design.md.
//
// ── WHY IT READS BYTES, NOT A BUILD LOG ─────────────────────────────────────
//
// Same argument as scripts/apk-self-update-marker.mjs, and it is the whole
// design: an attestation written beside an artifact proves THE BUILD WENT
// THROUGH OUR SCRIPT; only the artifact itself can say what is inside it. This
// module interrogates the bytes that will ship. It never runs them.
//
// ── THE CONTROL MARKER, AND THE THREE DIAGNOSES ─────────────────────────────
//
// A raw byte scan that finds nothing has two completely different meanings —
// "this build was not stamped" and "this scan cannot read this artifact at all"
// — with two opposite actions (rebuild through the stamping script / stop and
// re-measure the scanner). CLAUDE.md G13 rule ②: a negative assertion must
// carry a positive control, or the zero may be the probe being blind rather
// than the implementation being wrong. So every scan also counts a marker that
// is present in EVERY build of that artifact regardless of any stamp:
//
//   desktop exe  INJECT_FOCUS_LOST  — a Rust `&str` const in
//                apps/desktop/src-tauri/src/error_codes.rs, kept in step with
//                the protocol registry by a Rust test in that same file.
//                [measured 2026-09-17, dev-pc-a, on the 0.3.88 exe at
//                apps/desktop/src-tauri/target/release/flowmic-desktop.exe:
//                2 hits — so this scan can read that crate's string constants.]
//   APK          mobile:reconnect   — the same control the self-update marker
//                gate uses, for the reason its header gives (a generated
//                protocol event name, one hit per ABI).
//
// ── 🔴 THE EXE IS SCANNED, NOT THE MSI OR THE ZIP, AND THAT IS MEASURED ─────
//
// [measured 2026-09-17, dev-pc-a] `publish/FlowMic_0.3.88_x64_en-US.msi`
// contains ZERO hits for a string the exe it installs contains — an MSI carries
// its payload in a compressed cab, and the portable zip deflates the same exe.
// A raw scan of either would report "unstamped" about a perfectly stamped
// build. So the gate reads the SOURCE artifact both are made from
// (target/release/flowmic-desktop.exe), which is the same stance GATE 0d takes
// for the LAN-address scan and for the same reason.

// The stamp prefix is IMPORTED, never re-spelled here — the scanner and the
// builder must not be able to drift apart. The Rust and Dart sides cannot
// import it, so they are pinned by their own tests instead
// (build_stamp_tests.rs, apps/mobile/test/build_stamp_test.dart).
import { execFileSync } from 'node:child_process';

import { readValidReceipt } from '../gate-receipt.mjs';
import { DIRTY_PREFIX, NOGIT_VALUE, REPO_ROOT, STAMP_PREFIX, UNSTAMPED_VALUE } from './require-clean-sha.mjs';

export const EXE_CONTROL_MARKER = 'INJECT_FOCUS_LOST';
export const APK_CONTROL_MARKER = 'mobile:reconnect';

export { STAMP_PREFIX };

/** Characters a stamp value may contain. Anything else ends the value — the
 *  literal in the binary is followed by unrelated bytes, so the scan has to
 *  know where it stops. */
const VALUE_CHARS = /^[0-9a-z-]$/;

export function countMarker(buf, marker) {
  const needle = Buffer.from(marker, 'utf8');
  let n = 0;
  let at = buf.indexOf(needle, 0);
  while (at !== -1) {
    n += 1;
    at = buf.indexOf(needle, at + 1);
  }
  return n;
}

/** Every stamp value present in `buf`, in order of first appearance.
 *  More than one distinct value is itself a finding: it is what a warm build
 *  tree that reused one stale compiled unit would look like. */
export function readStampValues(buf) {
  const needle = Buffer.from(STAMP_PREFIX, 'utf8');
  const values = [];
  let at = buf.indexOf(needle, 0);
  while (at !== -1) {
    let end = at + needle.length;
    while (end < buf.length && end - (at + needle.length) < 64) {
      const ch = String.fromCharCode(buf[end]);
      if (!VALUE_CHARS.test(ch)) break;
      end += 1;
    }
    const value = buf.toString('utf8', at + needle.length, end);
    if (!values.includes(value)) values.push(value);
    at = buf.indexOf(needle, at + 1);
  }
  return values;
}

/**
 * @param {Buffer} buf — the artifact bytes
 * @param {string} controlMarker
 * @param {string} expectedSha — the commit the gate receipt names
 * @returns {{control:number, stamps:number, values:string[], verdict:'ok'|'blind'|'unstamped'|'mismatch'}}
 *
 * Order matters and mirrors the self-update gate: BLIND is decided FIRST. A run
 * where the scan cannot see anything must never be reported as "you built the
 * wrong commit" — that is a confident answer to a question the scan did not
 * manage to ask.
 */
export function scanArtifactForSha(buf, controlMarker, expectedSha) {
  const control = countMarker(buf, controlMarker);
  const stamps = countMarker(buf, STAMP_PREFIX);
  const values = readStampValues(buf);
  if (control === 0) return { control, stamps, values, verdict: 'blind' };
  if (values.length === 0 || (values.length === 1 && values[0] === UNSTAMPED_VALUE)) {
    return { control, stamps, values, verdict: 'unstamped' };
  }
  if (values.every((v) => v === expectedSha)) return { control, stamps, values, verdict: 'ok' };
  return { control, stamps, values, verdict: 'mismatch' };
}

/** The refusal text. Separated from publish.mjs so the drill can assert on the
 *  exact words an operator reads — the whole value of a red gate is that its
 *  message names the artifact, what was found, what was expected, and the
 *  action. */
export function shaStampRefusalMessage(label, scan, expectedSha, controlMarker, buildCommand) {
  if (scan.verdict === 'blind') {
    return (
      `${label}: the build-sha scan is BLIND — the control marker '${controlMarker}' is ` +
      `absent too (control=${scan.control}, stamps=${scan.stamps}). This says NOTHING about ` +
      `which commit built this artifact. Either this is not a FlowMic artifact, or its ` +
      `string constants are no longer readable by a raw byte scan (compression, packing, a ` +
      `renamed control constant). Re-measure the scanner before touching the build.`
    );
  }
  if (scan.verdict === 'unstamped') {
    return (
      `${label}: carries NO build sha (control marker present: ${scan.control} hits, so the ` +
      `scan can read this artifact's strings). It was built without ` +
      `scripts/build-stamp/with-build-sha.mjs, so it cannot say which commit it came from ` +
      `and nothing can prove it is the tree the gate receipt (${expectedSha.slice(0, 12)}…) ` +
      `describes. Rebuild with:  ${buildCommand}`
    );
  }
  const found = scan.values.map((v) => {
    if (v === UNSTAMPED_VALUE) return `${v} (a build that got no sha at all)`;
    if (v === NOGIT_VALUE) return `${v} (built outside a git checkout, FLOWMIC_BUILD_ALLOW_NO_GIT=1)`;
    if (v.startsWith(DIRTY_PREFIX)) return `${v} (built from a DIRTY tree, FLOWMIC_ALLOW_DIRTY_BUILD=1 — those bytes match no commit)`;
    return v;
  });
  return (
    `${label}: built from a DIFFERENT commit than the one the gate proved.\n` +
    `    found in the artifact: ${found.join(', ')}\n` +
    `    gate receipt says:     ${expectedSha}\n` +
    `    These bytes were never gated. Publishing them ships something no receipt describes ` +
    `— the exact state the parallel ship chain makes possible and this gate exists to catch.\n` +
    `    Rebuild at the gated commit:  ${buildCommand}`
  );
}

/**
 * WHICH COMMIT IS THE REFERENCE, and where that answer comes from.
 *
 * The authority is the gate receipt: it names the commit `pnpm verify:delivery`
 * actually proved. When there is no usable receipt — publish just ran the full
 * chain itself, or the tree moved during its own gate run so no receipt was
 * written — the reference falls back to `git rev-parse HEAD`, and the caller
 * SAYS SO. That fallback is deliberately weaker and deliberately named: the
 * question this gate asks is "is the artifact from the commit that was gated",
 * and a publish run that has just gated THIS tree can honestly use HEAD as that
 * commit. What is not allowed is silence about which of the two answered.
 *
 * Neither available ⇒ null, and the caller refuses. A gate that cannot ask its
 * question is a failed gate, not a skipped one (publish.mjs Gate 0 precedent).
 */
export function resolveGatedSha({ root = REPO_ROOT } = {}) {
  const r = readValidReceipt({ root });
  if (r.ok && /^[0-9a-f]{40}$/.test(r.receipt?.sha ?? '')) {
    return { sha: r.receipt.sha, source: `gate receipt (${r.receipt.gate}, ${r.receipt.finishedAt})` };
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) {
      return { sha: head, source: `git HEAD (no usable receipt: ${r.reason})` };
    }
  } catch {
    /* fall through to null */
  }
  return { sha: null, source: `no gate receipt (${r.reason}) and \`git rev-parse HEAD\` gave no answer` };
}

/**
 * GATE 0f for one artifact. Same signature shape as the other publish gate
 * modules: it reports through the caller's `fail`/`ok` and returns a boolean
 * rather than exiting, so an operator facing several bad artifacts hears about
 * all of them in one run.
 */
export function verifyArtifactBuildSha({ label, buf, controlMarker, expectedSha, buildCommand, fail, ok }) {
  if (!expectedSha) {
    fail(
      `${label}: cannot check which commit built this artifact — there is no reference sha. ` +
        `A gate that cannot ask its question is a FAILED gate, not a skipped one.`,
    );
    return false;
  }
  const scan = scanArtifactForSha(buf, controlMarker, expectedSha);
  if (scan.verdict === 'ok') {
    ok(`${label} was built from ${expectedSha.slice(0, 12)}… (control ${controlMarker}: ${scan.control} hits, ${scan.stamps} stamp${scan.stamps === 1 ? '' : 's'})`);
    return true;
  }
  fail(shaStampRefusalMessage(label, scan, expectedSha, controlMarker, buildCommand));
  return false;
}

export const DESKTOP_BUILD_COMMAND = 'pnpm --filter @flowmic/desktop tauri:build';
export const MOBILE_BUILD_COMMAND = 'make -C apps/mobile release';
