// scripts/ship-publish-flags.mjs — which of publish.mjs's two exits a ship plan
// takes. Lifted out of ship.mjs main() (two inline lines, unchanged in meaning)
// so scripts/ship-publish-argv.test.mjs can ask the SAME function for every
// plan ship can build, instead of re-deriving the rule beside it.
//
// The same fact about the plan decides both flags, and they are opposites:
// either nobody will update the live manifest this round (freeze: PUBLISH runs
// and MANIFEST does not), or a later step of this run will and gets to be the
// one that asserts it (deferral: both run). ship.mjs main() says why each
// exists; publish-freeze-round.mjs and publish-manifest-deferred.mjs say what
// each does.

/** @param {Set<string>} planNames node names in the plan */
export function publishPlanFlags(planNames) {
  return {
    freezeRound: planNames.has('PUBLISH') && !planNames.has('MANIFEST'),
    manifestDeferred: planNames.has('PUBLISH') && planNames.has('MANIFEST'),
  };
}
