// Card INC-1f — the rollback switch of "polish while speaking" and the one rule
// that arms it for a session. Design = docs/strategy/2026-10-13-realtime-polish-
// while-speaking-design.md D6, D8, §7.2, §9 item 1; contract = book 06 §5 INC-1a.
//
// FLOWMIC_POLISH_SPECULATIVE ∈ off (default, also when unset) | on. Parsed once
// when the session factory is built (engine/stt-factory.ts `makeSttSessionFactory`,
// next to `assertSttTuningEnv`), fail-loud on any other value — the same
// convention as stt/tuning-env.ts — and logged there. Each session snapshots the
// answer at audio:start, so a press never changes behaviour half way. Rolling
// back = `off` in the node's env file + a relay restart (no hot reload).

import { log } from '../log';

export const POLISH_SPECULATIVE_ENV = 'FLOWMIC_POLISH_SPECULATIVE';

export function readPolishSpeculativeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[POLISH_SPECULATIVE_ENV];
  if (raw === undefined || raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`${POLISH_SPECULATIVE_ENV}: expected "on" or "off", got ${JSON.stringify(raw)}`);
}

/** Read and log once at boot; throws on a typo (fail-loud). */
export function bootPolishSpeculative(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = readPolishSpeculativeFromEnv(env);
  log.info('stt.polish speculative switch', { [POLISH_SPECULATIVE_ENV]: on ? 'on' : 'off' });
  return on;
}

/**
 * The ONE arming rule (design D6 + §9 item 1). Off unless every condition holds:
 * the switch is on; polish is armed for this session (which already excludes
 * integrator rooms, stt-factory.ts EMB-15); realtime mode — translate and
 * organize get a polished final too, so they are kept identical by this test and
 * not by default; and the session is on the SEG-1 contract — continuous
 * recordings and recovery legs (`segmentKeepsPreSeg1Contract`) never speculate.
 */
export function speculationArmed(a: { switchOn: boolean; polishArmed: boolean; mode: string; continuous?: boolean; recoveryLeg?: boolean }): boolean {
  return a.switchOn && a.polishArmed && a.mode === 'realtime' && a.continuous !== true && a.recoveryLeg !== true;
}
