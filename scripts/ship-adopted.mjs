#!/usr/bin/env node
// scripts/ship-adopted.mjs — the one decision scripts/ship.mjs makes about
// bytes it did not build. Split out of ship.mjs VERBATIM on 2026-09-18 when
// that file crossed the 800-line cap; nothing here changed in the move, and
// ship.mjs re-exports it so no caller had to.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findCrossMachineArtifacts, KEEP_FLAG } from './publish-adopted-artifact-gate.mjs';

/**
 * Whether PUBLISH must be told to carry a cross-machine artifact through its
 * clean step — and the refusal when the bytes in publish/ cannot be trusted.
 *
 * 🔴 WHY SHIP DECIDES THIS AND NOT A HUMAN. The design's external queue (§3.2)
 * says the Mac lands its portable zip out of band and MANIFEST picks it up.
 * That is exactly the state `verifyAdoptedArtifactsSurvive` refuses by default:
 * a zip for THIS version that this machine cannot rebuild, sitting in the
 * directory the clean step is about to wipe. The default is right — an operator
 * must choose — but on a round whose whole model is "the Mac lands out of
 * band", the choice was already made when the artifact was adopted. Leaving it
 * to be typed means the chain dies at PUBLISH with every build already paid for
 * [measured 2026-09-18: FlowMic-0.3.92-portable-macos-arm64.zip in publish/].
 *
 * 🔴 WHAT IS NOT DELEGATED. Keeping bytes is only safe if they are the bytes
 * the producing machine vouched for, so this re-hashes each file and compares
 * it against its own sidecar. A missing sidecar or a mismatch is a REFUSAL —
 * ship does not pass the flag and does not start the round. Auto-keeping a file
 * whose hash disagrees with its attestation would turn a gate into a rubber
 * stamp, which is the one thing this whole file may not do.
 *
 * @returns {{keepAdopted:boolean, kept:string[], why:string}}
 * @throws  when something is at risk but unverifiable — the message names the
 *          file and what disagreed.
 */
export function adoptedKeepDecision({ outDir, version, readBytes = (f) => readFileSync(f) }) {
  const { atRisk } = findCrossMachineArtifacts({ outDir, version });
  if (atRisk.length === 0) {
    return { keepAdopted: false, kept: [], why: `no cross-machine artifact for ${version} in publish/` };
  }
  const bad = [];
  const kept = [];
  for (const a of atRisk) {
    if (!a.hasSidecar) { bad.push(`${a.name}: no ${a.sidecarName} beside it — nothing vouches for these bytes`); continue; }
    let actual;
    try { actual = createHash('sha256').update(readBytes(join(outDir, a.name))).digest('hex'); }
    catch (e) { bad.push(`${a.name}: could not be read (${e.message})`); continue; }
    if (actual.toLowerCase() !== String(a.attested).toLowerCase()) {
      bad.push(`${a.name}: ${a.sidecarName} attests ${a.attested}, the bytes on disk hash to ${actual}`);
      continue;
    }
    kept.push(a.name);
  }
  if (bad.length > 0) {
    throw new Error(
      [`cross-machine artifact(s) in publish/ cannot be carried through this round:`,
        ...bad.map((b) => `  ${b}`),
        `  ship will not pass ${KEEP_FLAG} for bytes their own sidecar does not match. Re-adopt from the producing`,
        '  machine (`node scripts/adopt-artifact.mjs <source> --sha256 <hash>`), or remove them and run again.',
      ].join('\n')
    );
  }
  return {
    keepAdopted: true,
    kept,
    why: `${kept.length} cross-machine artifact(s) for ${version} verified against their sidecars (${kept.join(', ')})`,
  };
}
