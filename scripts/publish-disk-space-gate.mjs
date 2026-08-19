// The free-space preflight of scripts/publish.mjs.
//
// Promotes docs/RELEASE-IRONRULES.md's 「磁盘」 rule out of its human-only §1 into
// §2 — cited by NAME, not by item number: that list renumbered twice on the day
// this was written, which is its own small lesson about coordinates. That rule
// existed because the repo volume has already hit ZERO bytes free during a
// round, and the only thing standing between us and the next time was somebody
// remembering to look at a drive letter before typing a command.
//
// ── WHY IT MEASURES THE REPO'S VOLUME AND NOT THE SYSTEM VOLUME ─────────────
//
// Because those are two different questions, and the owner's 2026-08-18 ruling
// (verify/lint/worktree-location.mjs carries the same distinction, for the same
// reason) is precisely that development output does NOT live on the system
// drive: publish/, the build trees and the bundles are all written beside the
// repo. Measured on dev-pc-a, 2026-08-19 — the system volume had 19.9 GB free
// while the repo volume had 252 GB. Either number is a confident-sounding
// answer to a question nobody asked; only the volume that will receive the
// bytes can refuse. So the reading is taken THROUGH the repo root itself
// (`statfs(root)`) rather than from a drive letter or a platform assumption —
// the ruler and the thing measured are then the same path by construction.
//
// ── WHY IT RUNS BEFORE EVERYTHING, INCLUDING GATE 0 ────────────────────────
//
// publish.mjs's first real act is `pnpm verify:delivery`, which rebuilds
// protocol/server-core dist, runs cargo, and writes hundreds of MB itself. A
// disk check that runs after it has already written is not a preflight, it is
// an autopsy. This one runs before this process writes a byte.
//
// ── THE THRESHOLD IS DERIVED, NOT CHOSEN ───────────────────────────────────
//
// Every term below is a measurement taken on dev-pc-a, 2026-08-19, on the
// completed 0.3.9 round that was still staged in publish/ at the time:
//
//   publish/ total (`du -sm publish`) ................ 373 MiB
//     of which: two MSIs .......................... 45.5 + 45.5 MiB
//               APK .................................... 72.4 MiB
//               windows portable zip ................... 45.4 MiB
//               FlowMic-portable/ (staged, kept beside
//                 its own zip for the whole round) ..... 123  MiB
//               adopted macos-arm64 zip ................ 41.0 MiB
//   a full-history git bundle (≈ `du -sm .git`) ...... 293 MiB
//
// A round therefore costs ~666 MiB of NEW bytes on this volume. The gate
// refuses below THREE times that, and the factor is not a preference either:
//
//   1×  this round's artefacts have to fit at all;
//   1×  last round's publish/ is not necessarily reclaimed — the clean step in
//       publish.mjs is explicitly best-effort and has a live EBUSY branch
//       ("could not clear … overwriting in place"), so two rounds' worth can
//       legitimately coexist on the volume;
//   1×  so that a successful round does not END at zero. The measured incident
//       was a volume at 0 bytes, and a volume at 0 breaks sqlite, git and the
//       editor — i.e. things that have nothing to do with publishing and whose
//       failure will not point back here.
//
// 1998 MiB is a deliberately odd number: it is the arithmetic, not a round
// figure someone liked. Re-measure the terms and it moves on its own.
//
// ⚠️ WHAT A PASS HERE DOES NOT MEAN. It does not mean the round will fit — it
// means the volume held the measured cost of the LAST round we measured, times
// three, at the moment this ran. A build tree that grows by a gigabyte between
// the check and the write is not covered, and nothing here watches the volume
// during the round.
//
// ── NO BYPASS FLAG, DELIBERATELY ───────────────────────────────────────────
//
// Same reasoning Gate 0 states verbatim: an env override is invisible to the
// next reader and a flag becomes the thing everyone types. If this ever has to
// be skipped, the honest way is to delete these lines in a commit somebody can
// see.
//
// ── REVERSE CONTROL (2026-08-19, dev-pc-a, run against the REAL volume) ────
//
// The mutation was HEADROOM_FACTOR 3 → 3000 — i.e. the derived threshold, not
// a stubbed reading: this arm had to prove the gate refuses on a real statfs of
// a real disk, not that a fake number compares correctly. Verbatim, both arms
// through verifyDiskHeadroom() with the real repo root and the real statfs:
//
//   ARM A (HEADROOM_FACTOR = 3000)
//   (MIN_FREE_MIB in the module right now = 1998000)
//   ✗ disk headroom: 240590 MiB free on the repo's own volume (F:\) — refusing to publish before anything is written.
//         measured : 240590 MiB free of 377856 MiB on F:\ (read through the repo root, which is where publish/ and the build trees land)
//         needed   : 1998000 MiB — one round costs ~666 MiB (measured 0.3.9: 373 MiB staged into publish/ + a 293 MiB full-history bundle), and this gate wants 3000× that so the round does not end at zero.
//         ⚠ this is the REPO's volume, deliberately not the system volume: the system volume being fine says nothing about where publish/ is written (owner ruling 2026-08-18, same distinction as verify:lint worktree-location).
//         to make room: apps/desktop/src-tauri/target/debug is the one safe deletion (measured 5.9 GiB on dev-pc-a) — `cargo build` rebuilds it, no release artifact is derived from it.
//   EXIT=1
//
//   ARM B (restored to 3, file diffed byte-identical against the backup first)
//   (MIN_FREE_MIB in the module right now = 1998)
//   ✓ disk headroom: 240590 MiB free on F:\ (repo volume; needs 1998 MiB = 3× a measured 666 MiB round)
//   EXIT=0
//
// (240590 MiB is smaller than the 252 GB quoted higher up: another agent's
// build was running on this volume between the two readings. That is the
// argument for the third factor, arriving unasked.)

import { statfsSync } from 'node:fs';
import { parse as parsePath, resolve } from 'node:path';

import { refuseDirectRun } from './module-entrypoint-guard.mjs';

// Same trap as its siblings: running a pure-function module directly evaluates
// definitions and exits 0, which is indistinguishable from "the check ran and
// passed".
refuseDirectRun(import.meta.url, 'node scripts/publish.mjs (or import verifyDiskHeadroom)');

/** MiB, measured — see the itemisation in the header. */
export const MEASURED_PUBLISH_MIB = 373;
/** MiB, measured — a full-history bundle is about the size of .git. */
export const MEASURED_BUNDLE_MIB = 293;
/** What one round costs in NEW bytes on the repo's volume. */
export const ROUND_MIB = MEASURED_PUBLISH_MIB + MEASURED_BUNDLE_MIB;
/** Why three, term by term, is in the header. Not a taste. */
export const HEADROOM_FACTOR = 3;
/** The refusal threshold, derived. Odd on purpose. */
export const MIN_FREE_MIB = ROUND_MIB * HEADROOM_FACTOR;

const MIB = 1024 * 1024;

/** The volume root of a path — `F:\` on Windows, `/` on POSIX. Used only for
 *  the human-readable half of the message; the measurement itself never goes
 *  through this string (see readFreeSpace). */
export function repoVolume(root) {
  return parsePath(resolve(root)).root;
}

/**
 * Read free space on the volume that holds `root`.
 *
 * 🔴 The reading is taken through `root` ITSELF, not through the volume string
 * above and not through `os.tmpdir()`. Two reasons, both measured in this repo:
 * the volume string is a second spelling of the same fact and would be the
 * thing that drifts, and the system temp directory is on the system volume,
 * which is exactly the volume this gate must NOT answer about.
 *
 * `statfs` is injectable so the drill can drive every verdict without filling
 * a disk — and so it can assert WHICH path was measured, which is the property
 * that separates this gate from one that quietly reports on C:.
 *
 * @returns {{verdict:'ok'|'low'|'unmeasurable', volume:string, freeMib?:number,
 *            totalMib?:number, reason?:string}}
 */
export function readFreeSpace(root, statfs = statfsSync) {
  const volume = repoVolume(root);
  let s;
  try {
    s = statfs(root);
  } catch (e) {
    return { verdict: 'unmeasurable', volume, reason: `statfs(${root}) threw: ${e.message}` };
  }
  const bsize = Number(s?.bsize);
  const bavail = Number(s?.bavail);
  const blocks = Number(s?.blocks);
  if (!Number.isFinite(bsize) || bsize <= 0 || !Number.isFinite(bavail) || !Number.isFinite(blocks)) {
    // A gate that could not measure must not report a verdict about the disk.
    // Same precedence the LAN-IP gate applies to its 'blind' state: say the
    // measurement failed, say nothing about the thing it failed to measure.
    return { verdict: 'unmeasurable', volume, reason: `statfs returned bsize=${s?.bsize} bavail=${s?.bavail} blocks=${s?.blocks}` };
  }
  const freeMib = Math.floor((bavail * bsize) / MIB);
  const totalMib = Math.floor((blocks * bsize) / MIB);
  return { verdict: freeMib >= MIN_FREE_MIB ? 'ok' : 'low', volume, freeMib, totalMib };
}

/**
 * The refusal an operator reads. Separated so the drill can assert the exact
 * sentence — the whole value of a red gate is that its message names the number
 * it measured and the action that follows from it.
 */
export function diskRefusalMessage(reading) {
  if (reading.verdict === 'unmeasurable') {
    return (
      `disk headroom: COULD NOT MEASURE the repo's volume (${reading.volume}) — ${reading.reason}.\n` +
      '    Refusing to publish. This says NOTHING about how much room you have: it says the\n' +
      '    measurement failed, and a round that starts on an unmeasured volume is exactly the\n' +
      '    state that ended with 0 bytes free once already. Check the path and re-run.'
    );
  }
  return (
    `disk headroom: ${reading.freeMib} MiB free on the repo's own volume (${reading.volume}) — refusing to publish before anything is written.\n` +
    `      measured : ${reading.freeMib} MiB free of ${reading.totalMib} MiB on ${reading.volume} (read through the repo root, which is where publish/ and the build trees land)\n` +
    `      needed   : ${MIN_FREE_MIB} MiB — one round costs ~${ROUND_MIB} MiB (measured 0.3.9: ${MEASURED_PUBLISH_MIB} MiB staged into publish/ + a ${MEASURED_BUNDLE_MIB} MiB full-history bundle), and this gate wants ${HEADROOM_FACTOR}× that so the round does not end at zero.\n` +
    "      ⚠ this is the REPO's volume, deliberately not the system volume: the system volume being fine says nothing about where publish/ is written (owner ruling 2026-08-18, same distinction as verify:lint worktree-location).\n" +
    '      to make room: apps/desktop/src-tauri/target/debug is the one safe deletion (measured 5.9 GiB on dev-pc-a) — `cargo build` rebuilds it, no release artifact is derived from it.'
  );
}

/**
 * The gate publish.mjs calls, before it writes anything at all.
 *
 * Takes `fail`/`ok` rather than throwing, matching publish-lan-ip-gate.mjs and
 * publish-apk-gates.mjs: the publisher collects refusals so an operator facing
 * two problems hears about both.
 *
 * @returns {boolean} true when the round may proceed.
 */
export function verifyDiskHeadroom(root, fail, ok, statfs = statfsSync) {
  const reading = readFreeSpace(root, statfs);
  if (reading.verdict !== 'ok') {
    fail(diskRefusalMessage(reading));
    return false;
  }
  ok(
    `disk headroom: ${reading.freeMib} MiB free on ${reading.volume} (repo volume; ` +
      `needs ${MIN_FREE_MIB} MiB = ${HEADROOM_FACTOR}× a measured ${ROUND_MIB} MiB round)`,
  );
  return true;
}
