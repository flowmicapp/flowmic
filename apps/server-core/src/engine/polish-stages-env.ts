// Card POL-3 — the rollback switch of "two-stage polish" (unit polish with
// read-only context from earlier rows). Design = docs/strategy/2026-10-14-two-
// stage-polish-design.md §8; contract = book 06 §5, the POL-0 block ("开关").
//
// FLOWMIC_POLISH_STAGES ∈ legacy (default, also when unset or empty) | context.
// Parsed once when the session factory is built (engine/stt-factory.ts
// `makeSttSessionFactory`, next to `bootPolishSpeculative`), fail-loud on any
// other value — the same convention as engine/polish-speculation-env.ts — and
// logged there. Each session snapshots the answer at audio:start (the factory
// copies it into `SttSessionDeps.polishStages`), so a press never changes
// behaviour half way. Rolling back = `legacy` in the node's env file + a relay
// restart (no hot reload).
//
// 🔴 `context+kick` IS REFUSED AT BOOT UNTIL CARD POL-5 LANDS. The contract lists
// it as the third value, but the kick (send the unit's request at the cut, before
// its final arrives) does not exist yet. Accepting it as a synonym of `context`
// would give an operator a switch whose name promises something the relay does
// not do, and the canary reading (design §8: compare `context` against
// `context+kick` on one node) would compare two identical runs. A refused boot is
// loud and immediate; a silently downgraded value is neither. POL-5 turns this
// into an accepted value in the same commit that implements it.
//
// 🔴 MUTUALLY EXCLUSIVE WITH FLOWMIC_POLISH_SPECULATIVE=on (design §3.1, §8):
// both replace the same polish call of the same final with a different unit, so
// together they would answer one question twice. The relay refuses to boot.

import { log } from '../log';

export const POLISH_STAGES_ENV = 'FLOWMIC_POLISH_STAGES';

/** What a session can be armed with. `legacy` is the absence of a value on the
 *  session deps (today's behaviour, byte for byte), never a stored string. */
export type PolishStages = 'legacy' | 'context';

export function readPolishStagesFromEnv(env: NodeJS.ProcessEnv = process.env): PolishStages {
  const raw = env[POLISH_STAGES_ENV];
  if (raw === undefined || raw === '' || raw === 'legacy') return 'legacy';
  if (raw === 'context') return 'context';
  if (raw === 'context+kick') {
    throw new Error(`${POLISH_STAGES_ENV}: "context+kick" is not implemented yet (card POL-5); use "legacy" or "context"`);
  }
  throw new Error(`${POLISH_STAGES_ENV}: expected "legacy" or "context", got ${JSON.stringify(raw)}`);
}

/** Read, check against the speculative switch, and log once at boot; throws on
 *  a typo or on the forbidden pair (fail-loud). `speculativeOn` is the value
 *  `bootPolishSpeculative` already returned, so the two switches are read once each. */
export function bootPolishStages(speculativeOn: boolean, env: NodeJS.ProcessEnv = process.env): PolishStages {
  const stages = readPolishStagesFromEnv(env);
  if (stages !== 'legacy' && speculativeOn) {
    throw new Error(`${POLISH_STAGES_ENV}=${stages} and FLOWMIC_POLISH_SPECULATIVE=on are mutually exclusive; set one of them back`);
  }
  log.info('stt.polish stages switch', { [POLISH_STAGES_ENV]: stages });
  return stages;
}
