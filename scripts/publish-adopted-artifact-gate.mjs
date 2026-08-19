// The cross-machine-artifact gate of scripts/publish.mjs.
//
// Promotes docs/RELEASE-IRONRULES.md's 「跨机产物：先 publish.mjs，再
// adopt-artifact.mjs」 rule out of its human-only §1 into §2 — cited by NAME,
// not by item number: that list renumbered twice on the day this was written.
//
// ── THE FAILURE THIS PREVENTS, AND WHY IT IS SILENT TODAY ──────────────────
//
// scripts/adopt-artifact.mjs exists because the macOS package is built, signed
// and notarized on another machine; adoption copies it into publish/ with the
// .sha256 sidecar that is the only evidence the uploader trusts. publish.mjs
// then starts its round by emptying publish/ (`rmSync(OUT, …)`). Nothing warns,
// nothing logs a name, and the operator's next visible signal is a download
// center with three platforms' worth of intent and two platforms' worth of
// bytes. The rule "adopt AFTER publish" was written down because of that, and a
// written-down ordering is the exact thing this repo has twice ruled should be
// a gate instead.
//
// The asymmetry is the whole point: every other file the clean step destroys is
// rebuilt by the same run, seconds later. A macOS artifact is not — getting it
// back means walking to another machine, rebuilding, re-notarizing, re-copying
// and re-adopting with a hash carried out of band.
//
// ── HOW "ADOPTED" IS DECIDED, AND WHY NOT FROM A RECEIPT ───────────────────
//
// From the artifact's own NAME, on disk, right now: a `.zip` in publish/ that
// carries a platform token from pack-portable.mjs's PORTABLE_PLATFORMS which is
// NOT the platform this round produces. Nothing else is consulted.
//
// 🔴 A receipt file written by adopt-artifact.mjs was the obvious design and is
// the wrong one. A receipt is a record that a command RAN; it can be stale,
// deleted, or written beside bytes somebody has since replaced by hand, and its
// most likely failure is being absent while the artifact is present — i.e. the
// gate goes quiet in exactly the case it exists for. The name cannot drift from
// the bytes in that direction: a Windows round does not produce a file claiming
// macos-arm64, so the claim IS the evidence. (It travels the same way the
// sidecar does — publish/ is the shared surface, not this process's memory.)
//
// ⚠️ BOUNDARY, stated rather than discovered later. This sees artifacts NAMED
// for a platform this machine does not build. A foreign artifact copied in
// under some other name is invisible to it. That set is closed at the producing
// end rather than here: adopt-artifact.mjs refuses to write a name whose
// platform it had to guess (`choosePlatform`), so anything it produced is in
// this set by construction. Anything a human dropped in by hand under a free-
// form name is not, and this gate does not claim otherwise.
//
// ── WHY A STALE-VERSION ARTIFACT IS NAMED BUT NOT REFUSED ──────────────────
//
// Because a gate that cries wolf gets deleted. A macos zip for a version this
// tree is no longer publishing is dead weight — publish.mjs already drops
// stale-versioned artifacts by name in its EBUSY branch, and the download
// center refuses anything whose name lacks the current version. Refusing the
// round over it would be a red on the correct behaviour. It is listed in the
// PASS line so nobody has to wonder whether the gate saw it.
//
// ── THE TWO WAYS TO PROCEED ON PURPOSE ─────────────────────────────────────
//
//   --keep-adopted     carry it through this round: the clean step removes
//                      everything EXCEPT that artifact and its sidecar, so the
//                      round ends with three platforms staged and the download
//                      center step at the end of publish.mjs uploads all of
//                      them. This is what an operator who adopted first
//                      actually wanted.
//   --discard-adopted  destroy it deliberately (the pre-gate behaviour). The
//                      refusal prints the attested sha256 from its sidecar so
//                      re-adopting afterwards needs nothing but the source file.
//
// Both are presence-only booleans and reject the `=value` spelling by name
// (IT-07), for the same reason adopt-artifact.mjs does: a flag that silently
// means something else is worse than a flag that refuses.
//
// ── REVERSE CONTROL (2026-08-19, dev-pc-a) ─────────────────────────────────
//
// Three arms, driven through the same fail/ok pair scripts/publish.mjs uses, on
// a fixture publish/ holding a 41 MiB macos-arm64 zip, its sidecar and this
// round's MSI. Verbatim:
//
//   ── ARM A: adopted artifact present, no flag ──
//   ✗ cross-machine artifact in publish/ would be DESTROYED by the clean step (1 file(s), and this machine cannot rebuild them):
//           FlowMic-9.9.9-portable-macos-arm64.zip  (41.0 MiB, macos-arm64, sha256 8b1a9953c4611296a827abf8c47804d7 — from its FlowMic-9.9.9-portable-macos-arm64.zip.sha256)
//         This round produces windows-x64. Those bytes came from another machine via scripts/adopt-artifact.mjs, and the clean step below is about to delete them silently — the round would then ship without them and nothing would say so.
//         Choose one, on purpose:
//           --keep-adopted     carry them through this round (the clean step keeps them and their sidecars; the download center step at the end uploads them with everything else)
//           --discard-adopted  delete them deliberately; re-adopt afterwards with `node scripts/adopt-artifact.mjs <source> --sha256 8b1a9953c4611296a827abf8c47804d755ef985ab4d8e5b0a1e0c4d3f2b19a70`
//   EXIT=1
//
//   ── ARM B: same directory, --keep-adopted ──
//   ✓ --keep-adopted: 1 cross-machine artifact(s) survive this round's clean step (FlowMic-9.9.9-portable-macos-arm64.zip, FlowMic-9.9.9-portable-macos-arm64.zip.sha256)
//   · publish/ after the clean step: FlowMic-9.9.9-portable-macos-arm64.zip, FlowMic-9.9.9-portable-macos-arm64.zip.sha256
//   · the adopted artifact is still 43008000 bytes (was 43008000)
//
//   ── ARM C: nothing adopted (the no-false-red arm) ──
//   ✓ no cross-machine artifact in publish/ that this round would destroy (this round builds windows-x64)
//   EXIT=0
//
// Arm C is the one that decides whether this gate survives contact with a
// normal round: a gate that cries wolf gets deleted, so "silent when nothing
// was adopted" is drilled as hard as the refusal. The matching REVERSE CONTROL
// for the destruction itself lives in the drill's §5 — keep=[] and the artifact
// is gone, which is publish.mjs's behaviour before this gate existed.
//
// ── AND A LIVE SIGHTING, the same day, on the real tree ────────────────────
//
// Run read-only against the actual publish/ of this repo at 0.3.9, the gate
// refused immediately: `FlowMic-0.3.9-portable-macos-arm64.zip (41.0 MiB,
// macos-arm64, sha256 1631642d3359cd58…)` was sitting there, adopted, with its
// sidecar. The next publish round would have deleted it without a word. This
// gate was not written against a hypothetical.

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { refuseDirectRun } from './module-entrypoint-guard.mjs';
import { DEFAULT_PORTABLE_PLATFORM, PORTABLE_PLATFORMS, parsePortableZipName } from './pack-portable.mjs';

refuseDirectRun(import.meta.url, 'node scripts/publish.mjs (or import verifyAdoptedArtifactsSurvive)');

export const KEEP_FLAG = '--keep-adopted';
export const DISCARD_FLAG = '--discard-adopted';

/** The platform a publish round on this machine produces. Imported, not
 *  spelled again: scripts/publish-portable-archive.mjs names the zip with
 *  `portableZipName(version)`, whose default is this same constant, so "what
 *  did this round build" has one answer rather than two that can drift. */
export const ROUND_PLATFORM = DEFAULT_PORTABLE_PLATFORM;

const VERSION_TOKEN_RE = /\d+\.\d+\.\d+/;

/**
 * Classify one publish/ entry.
 *
 * @returns {null | {name:string, platforms:string[], version:string|null, atRisk:boolean}}
 *   null when the entry is not a platform-named zip (i.e. not in the adoptable
 *   set — see the BOUNDARY note in the header).
 */
export function classifyEntry(name, { version, roundPlatform = ROUND_PLATFORM } = {}) {
  if (!/\.zip$/i.test(name)) return null;
  const platforms = [...PORTABLE_PLATFORMS].filter((p) => name.includes(p));
  if (platforms.length === 0) return null;
  // Carries this round's own platform ⇒ this run rebuilds it. Not cross-machine
  // even if it also mentions another token: the round is about to overwrite it
  // by name anyway.
  if (platforms.includes(roundPlatform)) return null;
  // The canonical adopted name gives the version directly; a hand-placed name
  // (e.g. the raw `FlowMic-<v>-macos-arm64.zip` the Mac produces) still carries
  // a version token, so both shapes answer.
  const parsed = parsePortableZipName(name);
  const found = parsed ? parsed.version : (name.match(VERSION_TOKEN_RE)?.[0] ?? null);
  // No version in the name ⇒ at risk. This machine cannot rebuild it and
  // nothing here can prove it belongs to a round that is over.
  const atRisk = found === null || found === version;
  return { name, platforms, version: found, atRisk };
}

/**
 * Everything in publish/ that this round did not build and cannot rebuild.
 *
 * `entries` is injectable so the drill can classify a directory listing without
 * a directory; the default reads the real one. A missing publish/ is not an
 * error — a first round on a fresh checkout has none.
 */
export function findCrossMachineArtifacts({ outDir, version, roundPlatform = ROUND_PLATFORM, entries = null }) {
  const names = entries ?? (existsSync(outDir) ? readdirSync(outDir) : []);
  const atRisk = [];
  const stale = [];
  for (const name of names.slice().sort()) {
    const hit = classifyEntry(name, { version, roundPlatform });
    if (!hit) continue;
    const sidecarName = `${name}.sha256`;
    const sidecarPath = join(outDir, sidecarName);
    let attested = null;
    try {
      attested = readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0] || null;
    } catch { /* no sidecar — reported below, never invented */ }
    let bytes = null;
    try { bytes = statSync(join(outDir, name)).size; } catch { /* listing came from a fixture */ }
    const record = { ...hit, sidecarName, hasSidecar: attested !== null, attested, bytes };
    (hit.atRisk ? atRisk : stale).push(record);
  }
  return { atRisk, stale };
}

/**
 * Which disposition the operator asked for.
 * @returns {{mode:'unstated'|'keep'|'discard', error:string|null}}
 */
export function readDisposition(argv) {
  for (const flag of [KEEP_FLAG, DISCARD_FLAG]) {
    const bad = argv.find((a) => a.startsWith(`${flag}=`));
    if (bad) {
      return { mode: 'unstated', error: `${flag}=… is not accepted. Use bare ${flag} (no =value). Got: ${bad}` };
    }
  }
  const keep = argv.includes(KEEP_FLAG);
  const discard = argv.includes(DISCARD_FLAG);
  if (keep && discard) {
    return {
      mode: 'unstated',
      error: `${KEEP_FLAG} and ${DISCARD_FLAG} together say opposite things about the same file. Pass exactly one.`,
    };
  }
  if (keep) return { mode: 'keep', error: null };
  if (discard) return { mode: 'discard', error: null };
  return { mode: 'unstated', error: null };
}

const mib = (n) => (n === null ? '?' : (n / 1024 / 1024).toFixed(1));

function describe(a) {
  const sha = a.hasSidecar
    ? `sha256 ${a.attested.slice(0, 32)} — from its ${a.sidecarName}`
    : `NO ${a.sidecarName} beside it — the download center would refuse it anyway (it uploads only what a sidecar vouches for)`;
  return `        ${a.name}  (${mib(a.bytes)} MiB, ${a.platforms.join('+')}, ${sha})`;
}

/** The refusal an operator reads. Separated so the drill can assert the exact
 *  sentence: this gate's entire value is that it names the file and the flag. */
export function adoptedRefusalMessage(atRisk, { roundPlatform = ROUND_PLATFORM } = {}) {
  const first = atRisk[0];
  const reAdopt = first?.hasSidecar
    ? `\`node scripts/adopt-artifact.mjs <source> --sha256 ${first.attested}\``
    : '`node scripts/adopt-artifact.mjs <source> --sha256 <hash-from-the-producing-machine>`';
  return (
    `cross-machine artifact in publish/ would be DESTROYED by the clean step ` +
    `(${atRisk.length} file(s), and this machine cannot rebuild them):\n` +
    `${atRisk.map(describe).join('\n')}\n` +
    `      This round produces ${roundPlatform}. Those bytes came from another machine via ` +
    `scripts/adopt-artifact.mjs, and the clean step below is about to delete them silently — the round ` +
    `would then ship without them and nothing would say so.\n` +
    '      Choose one, on purpose:\n' +
    `        ${KEEP_FLAG}     carry them through this round (the clean step keeps them and their sidecars; ` +
    'the download center step at the end uploads them with everything else)\n' +
    `        ${DISCARD_FLAG}  delete them deliberately; re-adopt afterwards with ${reAdopt}`
  );
}

/**
 * The gate publish.mjs calls — twice, deliberately: once before Gate 0 so the
 * refusal is cheap, and once immediately before the removal it governs, because
 * publish/ is shared between windows (measured 2026-08-08: another window
 * staged an artifact there mid-card) and a check that ran ten minutes earlier
 * is a claim about a directory that has since moved on.
 *
 * @returns {{keep:string[], atRisk:Array, stale:Array, refusal:string|null, notice:string}}
 *   `keep` is the exact set of names the clean step must NOT remove — empty on
 *   every normal round, which is what makes this gate silent when nothing was
 *   adopted.
 */
export function verifyAdoptedArtifactsSurvive({ outDir, version, argv = process.argv, roundPlatform = ROUND_PLATFORM, entries = null }) {
  const { atRisk, stale } = findCrossMachineArtifacts({ outDir, version, roundPlatform, entries });
  const staleNote = stale.length > 0
    ? `; ${stale.length} stale cross-machine file(s) will be cleaned as usual (${stale.map((s) => s.name).join(', ')})`
    : '';
  const disposition = readDisposition(argv);

  if (disposition.error) {
    // A malformed disposition must never degrade to "unstated" when something
    // is at risk, and must not pass unnoticed when nothing is: the operator
    // typed a flag meaning to say something.
    return { keep: [], atRisk, stale, refusal: disposition.error, notice: '' };
  }
  if (atRisk.length === 0) {
    return {
      keep: [],
      atRisk,
      stale,
      refusal: null,
      notice: `no cross-machine artifact in publish/ that this round would destroy (this round builds ${roundPlatform})${staleNote}`,
    };
  }
  if (disposition.mode === 'unstated') {
    return { keep: [], atRisk, stale, refusal: adoptedRefusalMessage(atRisk, { roundPlatform }), notice: '' };
  }
  if (disposition.mode === 'discard') {
    return {
      keep: [],
      atRisk,
      stale,
      refusal: null,
      notice: `${DISCARD_FLAG}: ${atRisk.length} cross-machine artifact(s) will be destroyed on purpose (${atRisk.map((a) => a.name).join(', ')})${staleNote}`,
    };
  }
  const keep = [];
  for (const a of atRisk) {
    keep.push(a.name);
    if (a.hasSidecar) keep.push(a.sidecarName);
  }
  return {
    keep,
    atRisk,
    stale,
    refusal: null,
    notice: `${KEEP_FLAG}: ${atRisk.length} cross-machine artifact(s) survive this round's clean step (${keep.join(', ')})${staleNote}`,
  };
}

/**
 * The clean step, when something must survive it.
 *
 * Deliberately NOT "copy aside, wipe, copy back": publish.mjs writes only under
 * publish/ (RV-73) and a 41 MiB round trip through a temp directory is a second
 * place for the bytes to be corrupted between two hash checks nobody runs.
 * Removing every entry except the keep set touches the kept file zero times,
 * which is the strongest form of "it survived".
 *
 * Per-entry failures are reported and swallowed, matching the whole-directory
 * clean this replaces: that one is explicitly best-effort ("A best-effort
 * clean, NOT a precondition") because an editor or antivirus holding a file is
 * not a reason to refuse a round. A kept file is never touched, so it cannot be
 * the one that fails.
 *
 * @returns {{removed:string[], failed:Array<{name:string, code:string}>, kept:string[]}}
 */
export function removeAllExcept(outDir, keepNames, log = () => {}) {
  const keep = new Set(keepNames);
  const removed = [];
  const failed = [];
  if (!existsSync(outDir)) return { removed, failed, kept: [...keep] };
  for (const name of readdirSync(outDir)) {
    if (keep.has(name)) continue;
    const p = join(outDir, name);
    try {
      // lstat, not stat: a symlink to a directory must be removed as the link
      // it is, never followed.
      const recursive = lstatSync(p).isDirectory();
      rmSync(p, { recursive, force: true });
      removed.push(name);
    } catch (e) {
      failed.push({ name, code: e.code ?? 'ERR' });
      log(`· could not remove ${name} (${e.code ?? e.message}) — it will be overwritten by name if this round produces it`);
    }
  }
  return { removed, failed, kept: [...keep] };
}
