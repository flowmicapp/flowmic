// scripts/publish-freeze-round.mjs — the `--freeze-round` exit for publish.mjs.
//
// WHY THIS EXISTS. `publish.mjs` ends every LAN-publishing run on the ruling ①
// companion gate: the live `/api/updates/latest` must already advertise this
// round, or the run exits 1 ("发布还没有做完"). That gate is correct and has no
// skip switch on purpose — its whole shape is «do not let you think you are
// done».
//
// Since 2026-09-09 the owner has frozen releases: nobody may touch the live
// manifest. So a round that legitimately ends at the internal download centre
// CANNOT end green — and the orchestrator (`scripts/ship.mjs`) hangs its
// DEPLOY_* steps off PUBLISH's exit code, which means a frozen manifest made
// the whole deploy half unreachable through the chain.
// [measured 2026-09-18, dev-pc-a, first real ship run: PUBLISH did everything —
// artifacts staged, download centre at /latest=0.3.90, gates 0/0d/0e/0f green —
// then died on the manifest gate, blocking DEPLOY_NY/JP/GO.]
//
// 🔴 WHAT THIS IS NOT. It is not a skip. The gate is not made quieter, is not
// made conditional on a heuristic, and is not made to pass. The run stops at
// exactly the same place it stopped before and says the same thing — that the
// live manifest was NOT updated and what it still points at — and then exits 0
// because in a freeze round that state is the intended end of the round, not a
// half-finished one. The difference between "this round did not update the
// manifest" and "this round forgot to update the manifest" is the operator's
// explicit flag, and nothing else.
//
// 🔴 AND IT REFUSES TO SHARE A RUN WITH ANYTHING THAT PUBLISHES OUTWARD.
// Fail closed by ALLOWLIST rather than by a list of forbidden flags: a future
// flag that publishes somewhere (a GitHub release, a store upload — today those
// live in separate scripts, `publish-github-release.mjs` above all) would not
// be on a denylist written before it existed, and would silently inherit the
// freeze exit. Only the flags below are known to be compatible with a freeze
// round; anything else alongside `--freeze-round` is refused by name.

import { fetchLiveManifest, resolveLiveManifestUrl } from './update-manifest-lib.mjs';

export const FREEZE_FLAG = '--freeze-round';

/** Flags that may legitimately appear beside `--freeze-round`.
 *
 *  `--skip-lan` is here because it publishes nowhere at all (it is the offline
 *  round). `--with-manifest` is deliberately ABSENT: it writes the very file
 *  the freeze forbids touching, so the two flags are a contradiction, not a
 *  combination. */
export const FREEZE_COMPATIBLE_FLAGS = Object.freeze(['--freeze-round', '--skip-lan']);

/**
 * Pure: the refusal text for an argv, or null when the run may proceed.
 * Only speaks when `--freeze-round` is present — without it, publish.mjs's
 * behaviour is unchanged in every respect.
 */
export function freezeRefusal(argv = []) {
  if (!argv.includes(FREEZE_FLAG)) return null;
  const strangers = argv.filter((a) => a.startsWith('--') && !FREEZE_COMPATIBLE_FLAGS.includes(a));
  if (strangers.length === 0) return null;
  return (
    `✗ ${FREEZE_FLAG} refused alongside ${strangers.join(' ')}.\n`
    + '  A freeze round ends at the internal download centre and tells nobody outside about it.\n'
    + `  ${strangers.join(' ')} ${strangers.length === 1 ? 'publishes' : 'publish'} outward (or writes the live manifest), which is the one thing\n`
    + '  a freeze round may not do. Run one or the other, never both.\n'
    + `  (Flags known to be compatible with a freeze round: ${FREEZE_COMPATIBLE_FLAGS.join(' ')}.\n`
    + '   This is an allowlist on purpose: a flag added later must be judged, not inherited.)'
  );
}

/**
 * Pure: turn a fetched live manifest into one short phrase naming what it still
 * points at — or, when the endpoint could not be asked, say THAT instead.
 *
 * 🔴 "I could not ask" is never dressed as "it points at nothing" (§1-21's
 * three states). A freeze block that invents a version is worse than one that
 * admits the endpoint was unreachable, because the whole point of the block is
 * to tell a reader what installed clients are still being offered.
 */
export function describeLive(fetched) {
  if (!fetched || fetched.verdict === 'unreachable') {
    return `COULD NOT ASK (${fetched?.error ?? 'no answer'}) — this block does NOT claim to know what the live manifest says`;
  }
  if (fetched.verdict !== 'ok' || !fetched.manifest) {
    return `NO USABLE MANIFEST at that URL (${fetched.detail ?? `status ${fetched.status}`})`;
  }
  const parts = [];
  for (const [name, entry] of Object.entries(fetched.manifest.platforms ?? {})) {
    if (entry?.version) parts.push(`${name}=${entry.version}`);
  }
  for (const [name, entry] of Object.entries(fetched.manifest.store_platforms ?? {})) {
    if (entry?.version) parts.push(`${name}=${entry.version}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'a manifest with no platform versions at all';
}

/** Pure: the block publish.mjs prints in place of the gate. */
export function freezeBlock({ version, live, url }) {
  const bar = '='.repeat(74);
  return (
    `\n${bar}\n`
    + `  MANIFEST NOT UPDATED — release freeze round (owner 2026-09-09); the live\n`
    + `  manifest still points at ${live}\n`
    + `${bar}\n`
    + `  This round published ${version} to the internal download centre and stopped there.\n`
    + '  Nothing told an installed client that it exists, and nothing was supposed to:\n'
    + '  the live manifest, the public release, TestFlight and the public repo are all\n'
    + '  frozen until the owner lifts the freeze.\n'
    + `  Asked: ${url}\n`
    + '  When the freeze lifts, the remaining half is still the same three steps:\n'
    + '    1. node scripts/build-update-manifest.mjs\n'
    + '    2. deploy publish/update-manifest.json as live /etc/flowmic-app/updates.json\n'
    + '    3. node scripts/verify-live-update-manifest.mjs   (until green)\n'
    + `${bar}\n`
  );
}

/**
 * The impure half: ask the live endpoint, then hand back the block text.
 * Separated so the drill can drive `freezeBlock`/`describeLive` with no network
 * at all, and so a network failure here can only ever change the WORDS in the
 * block — never the exit code.
 */
export async function freezeNotice({ version, env = process.env } = {}) {
  const url = resolveLiveManifestUrl(env);
  let fetched = null;
  try {
    fetched = await fetchLiveManifest({ url });
  } catch (err) {
    fetched = { verdict: 'unreachable', status: null, manifest: null, detail: null, error: String(err?.message ?? err) };
  }
  return freezeBlock({ version, live: describeLive(fetched), url });
}
