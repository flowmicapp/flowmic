// scripts/publish-manifest-deferred.mjs — the `--manifest-deferred` exit for
// publish.mjs, for a round that IS going to update the live manifest, just not
// at this step.
//
// WHY THIS EXISTS. Ruling ① (owner 2026-08-10) says a publish run may not end
// green while the public `/api/updates/latest` still advertises the previous
// version. `publish.mjs` enforces that as its last act, and that placement was
// right when publishing was a thing a person did by hand and then followed with
// the manifest half by hand.
//
// It is NOT right inside `scripts/ship.mjs`, and the first non-freeze round
// would have proved it the hard way: in the orchestrated graph the manifest is
// built and carried to the relay nodes by steps that are DOWNSTREAM of PUBLISH,
// so at the moment publish asks the question the honest answer is always "no,
// not yet" — and every step that could make it true hangs off publish's exit
// code. The gate would have failed the round it was supposed to be protecting,
// every time, for a reason that is a fact about the graph rather than about the
// release [scripts/ship.mjs, measured 2026-09-18: PUBLISH did everything and
// died here; DEPLOY_NY/JP/GO were unreachable behind it].
//
// 🔴 WHAT THIS IS NOT. It is not a skip, and it is not the freeze exit. The
// freeze exit says «this round tells installed clients NOTHING, on purpose».
// This one says «this round WILL tell them, at a later step of this same run,
// and that step asserts exactly what this gate would have asserted». The
// assertion is moved, not weakened: `scripts/ship.mjs`'s VERIFY_MANIFEST node
// runs `scripts/verify-live-update-manifest.mjs` — the same script this gate
// spawns — after the relays are serving the new manifest, and a red answer
// there fails the ship. If that node is ever removed, the drill in
// scripts/ship-orchestrator.test.mjs goes red: the whole point of a deferral is
// that somebody downstream is holding the other end.
//
// 🔴 AND IT IS NOT TYPEABLE BY HAND. The deferral is only true inside a run
// that owns the later step; typed at a terminal it would be an ordinary bypass
// of ruling ①, with nobody downstream at all. So it is refused unless
// FLOWMIC_SHIP_RUN_PID is set — the variable the orchestrator gives every child
// and nothing else sets. That is a weak lock against a determined person and a
// complete one against the failure this file actually fears: the flag being
// copied out of a ship log into a hand-typed command because it "made publish
// pass last time".

import { fetchLiveManifest, resolveLiveManifestUrl } from './update-manifest-lib.mjs';
import { describeLive } from './publish-freeze-round.mjs';

export const DEFERRED_FLAG = '--manifest-deferred';
export const SHIP_PID_ENV = 'FLOWMIC_SHIP_RUN_PID';

/**
 * Pure: the refusal text for an argv, or null when the run may proceed.
 * Silent unless the flag is present — without it publish.mjs is unchanged.
 *
 * ⚠️ The `--freeze-round` pairing is NOT checked here: the two flags are
 * contradictory (one says "nobody will tell them", the other "a later step
 * will"), and `freezeRefusal`'s allowlist already refuses any stranger beside
 * the freeze flag, this one included. A second check would be a second place to
 * keep in step with that allowlist.
 */
export function deferralRefusal(argv = [], env = process.env) {
  if (!argv.includes(DEFERRED_FLAG)) return null;
  if (env[SHIP_PID_ENV]) return null;
  return (
    `x ${DEFERRED_FLAG} refused: it is only meaningful inside a \`pnpm ship\` run.\n`
    + '  The flag does not skip ruling ①\'s live-manifest gate; it moves the assertion to a\n'
    + '  later step of the SAME run (ship.mjs\'s VERIFY_MANIFEST, which runs\n'
    + '  scripts/verify-live-update-manifest.mjs once the relays carry the new manifest and\n'
    + '  fails the ship if the live endpoint still names the old version).\n'
    + `  Typed by hand there is no later step, so this would simply be ruling ① turned off.\n`
    + `  (${SHIP_PID_ENV} is unset, so nothing is holding the other end of this deferral.)\n`
    + '  Run `pnpm ship`, or drop the flag and let publish end on the gate as usual.'
  );
}

/** Pure: the block publish.mjs prints in place of the gate. */
export function deferredBlock({ version, live, url }) {
  const bar = '='.repeat(74);
  return (
    `\n${bar}\n`
    + '  LIVE-MANIFEST GATE DEFERRED TO THE MANIFEST STEP (ruling ① 2026-08-10)\n'
    + `${bar}\n`
    + `  This run published ${version} to the internal download centre. The live manifest\n`
    + `  still points at ${live}\n`
    + '  — which at this moment is the CORRECT state, not a failure: in an orchestrated\n'
    + '  round the manifest is built and carried to the relay nodes by steps that run\n'
    + '  AFTER this one, so this gate could only ever answer "not yet" here.\n'
    + '  The same assertion still gets made, by the step that can answer it honestly:\n'
    + '    ship.mjs VERIFY_MANIFEST -> node scripts/verify-live-update-manifest.mjs\n'
    + '  A red answer there fails the ship. Nothing about ruling ① is weakened; the\n'
    + '  question is asked at the one node in the graph where the answer can be yes.\n'
    + `  Asked here (for the record): ${url}\n`
    + `${bar}\n`
  );
}

/**
 * The impure half: ask the live endpoint, then hand back the block text.
 * Split the same way the freeze notice is, and for the same reason — a network
 * failure here may only change the WORDS in the block, never an exit code.
 */
export async function deferredNotice({ version, env = process.env } = {}) {
  const url = resolveLiveManifestUrl(env);
  let fetched = null;
  try {
    fetched = await fetchLiveManifest({ url });
  } catch (err) {
    fetched = { verdict: 'unreachable', status: null, manifest: null, detail: null, error: String(err?.message ?? err) };
  }
  return deferredBlock({ version, live: describeLive(fetched), url });
}
