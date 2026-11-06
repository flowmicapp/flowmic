// scripts/publish-argv.mjs — every flag-combination refusal publish.mjs makes
// before it writes a byte, as ONE pure function.
//
// WHY ONE FUNCTION. scripts/ship.mjs builds publish.mjs's command line from the
// plan (`--freeze-round`, `--manifest-deferred`, `--keep-adopted`), and
// publish.mjs refuses certain combinations. The two were checked in two
// places that never met: on the 0.3.119 round (2026-11-03) ship's stage 1
// would have handed publish `--freeze-round --keep-adopted`, which the freeze
// allowlist refused, and the release was finished by hand. publish.mjs now
// asks THIS function and scripts/ship-publish-argv.test.mjs feeds it every
// command line ship can build, so a new refusal added here is a new refusal
// that test sees, with nobody having to remember to copy it.
//
// Pure: argv and env in, the refusal text (or null) out. publish.mjs prints it
// and exits 1.

import { freezeRefusal } from './publish-freeze-round.mjs';
import { deferralRefusal } from './publish-manifest-deferred.mjs';
import { readDisposition } from './publish-adopted-artifact-gate.mjs';

export function withManifestSkipLanRefusal(argv = []) {
  if (!(argv.includes('--with-manifest') && argv.includes('--skip-lan'))) return null;
  return (
    '✗ --with-manifest with --skip-lan refused: the manifest would point at artifacts ' +
    'nothing has uploaded anywhere yet (先产物后清单铁律). Either drop --skip-lan so this ' +
    'run uploads to the LAN download center before the manifest is built, or omit ' +
    '--with-manifest and run `node scripts/build-update-manifest.mjs` by hand once you have ' +
    'uploaded the artifacts yourself.'
  );
}

/** @returns {string|null} the first refusal, in the order publish.mjs has always asked. */
export function publishArgvRefusal(argv = [], env = process.env) {
  const disposition = readDisposition(argv).error;
  return freezeRefusal(argv)
    ?? deferralRefusal(argv, env)
    ?? withManifestSkipLanRefusal(argv)
    ?? (disposition ? `✗ ${disposition}` : null);
}
