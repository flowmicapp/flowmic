// SPEC-REF:
//   docs/strategy/2026-09-06-audio-durability-device-drill.md B-1 (the scenario
//     this hook exists to reproduce: the speech engine is dead while the socket
//     stays alive)
//   docs/strategy/2026-08-27-project-status-log.md §A2-2 E7 (the defect the drill
//     exercises), anchor `<a id="audio-durability-audit-draft">`
//   docs/rebuild/10-OPS-DEPLOY.md (the env table this switch is listed in)
//   CLAUDE.md red line: no silent failure — a bad value here aborts start, and a
//     saas process says out loud that it ignored the switch.
//
// TEST-ONLY FAULT HOOK. `FLOWMIC_FAULT_STT_STALL_MS=<n>` makes the STT provider
// look DEAD for the first n ms of every recording, without changing anything
// else about the session.
//
// 🔴 WHY IT WRAPS THE ENGINE AND NOT THE ORCHESTRATOR. The drill needs the phone
// to see EXACTLY what a dead vendor produces, and "what the phone sees" on a dead
// vendor is not silence — it is whatever `stt/orchestrator-core.ts` decides to
// emit when a flush comes back with nothing (the terminal-final / empty-final
// path, `empty_reason` included). That machinery is OURS, not the provider's. So
// the suppression is applied at the provider boundary — the `SttEngine`'s own
// `interim` / `final` events — and every layer above it runs untouched and
// produces its real answer. Suppressing at the orchestrator would have deleted
// the very output the drill is there to observe.
//
// What is deliberately NOT touched, because the drill's whole point is that these
// keep working while recognition is dead:
//   - `pushChunk` / seq tracking / the ring buffer (the engine is still fed);
//   - `stt:level` (computed in `engine/stt-session.ts` from the VAD, upstream of
//     the engine) — the drill wants to PROVE that a live level meter is not
//     evidence of recognition;
//   - the coverage receipt's `fed_frames` (counted on the pipeline's answer to
//     `pushChunk`, which the hook does not intercept).
//
// Nothing here fabricates a frame. The hook only ever DROPS provider events.

import type { EventEmitter } from 'node:events';
import type { ServerMode } from '@flowmic/protocol';
import type { EngineFactory } from './engine-router';
import type { SttEngine } from './engines/base';
import { log } from '../log';

export const FAULT_STT_STALL_ENV = 'FLOWMIC_FAULT_STT_STALL_MS';

/**
 * Read the switch, or 0 for "not armed".
 *
 * 🔴 THE MODE GUARD IS THE WHOLE SAFETY ARGUMENT. This is the ONE place that
 * turns the env var into a number, and it answers 0 for every mode but
 * `standalone` — so on the relay the decorator below is never built and the hook
 * is unreachable by construction, not by anybody remembering to check. A saas
 * process that was handed the variable says so ONCE at boot rather than silently
 * doing nothing (a switch that is set and ignored without a word is the shape
 * CLAUDE.md's "no silent failure" line forbids).
 *
 * A malformed value THROWS. Same discipline as `assertSttTuningEnv`: a fault
 * injector that quietly disarms itself because the operator typed `2s` would let
 * a drill report "the defect did not reproduce" when the defect was never armed.
 */
export function resolveSttFaultStallMs(mode: ServerMode, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FAULT_STT_STALL_ENV];
  if (raw === undefined || raw.trim() === '') return 0;
  if (mode !== 'standalone') {
    log.warn(`${FAULT_STT_STALL_ENV} IGNORED — the STT fault hook is standalone-only`, { mode, value: raw });
    return 0;
  }
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(
      `config: ${FAULT_STT_STALL_ENV} must be a non-negative integer number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * Wrap an {@link EngineFactory} so every engine it builds stays MUTE for the
 * first `stallMs` of this recording.
 *
 * The deadline is fixed HERE, when the decorator is built. Production builds the
 * decorator chain once per `audio:start` (`makeSttOrchestratorFactory`'s returned
 * closure), so "n ms after audio:start" is what the operator gets — and an engine
 * ROLLOVER mid-session inherits the same deadline instead of restarting the
 * window, which is what a dead-then-recovered vendor actually looks like.
 *
 * `stallMs <= 0` returns `inner` unchanged: unset ⇒ not merely a no-op wrapper,
 * but no wrapper at all.
 */
export function withSttFaultStall(inner: EngineFactory, stallMs: number, now: () => number = Date.now): EngineFactory {
  if (stallMs <= 0) return inner;
  const liftAtMs = now() + stallMs;
  log.warn('stt.fault stall armed', { ms: stallMs });
  return (id, cfg) => muteEngineUntil(inner(id, cfg), liftAtMs, stallMs, now);
}

/**
 * Swallow this engine's `interim` / `final` events until `liftAtMs`.
 *
 * ⚠️ It patches the instance's `emit` rather than returning a proxy object on
 * purpose. Every `SttEngine` is a concrete `EventEmitter` subclass whose surface
 * the orchestrator reads directly (`id`, `state`, `interimShape`, `push`,
 * `flush`, `close`, `open?`, plus the emitter methods); a hand-written proxy is a
 * SECOND copy of that surface that goes stale the day a field is added — and a
 * fault injector that silently stops forwarding a field would corrupt the very
 * measurement it serves. Patching one method leaves the object itself in place.
 *
 * `error` and `state` pass through untouched: a dead provider still reports
 * transport failures, and hiding them would model a different fault.
 */
function muteEngineUntil(engine: SttEngine, liftAtMs: number, stallMs: number, now: () => number): SttEngine {
  const emitter = engine as unknown as EventEmitter;
  const passThrough = emitter.emit.bind(emitter);
  let suppressed = 0;
  let lifted = false;
  emitter.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'interim' || event === 'final') {
      if (now() < liftAtMs) {
        suppressed += 1;
        return false;
      }
      if (!lifted) {
        lifted = true;
        log.warn('stt.fault stall lifted', { ms: stallMs, engine: engine.id, suppressed_events: suppressed });
      }
    }
    return passThrough(event, ...args);
  }) as EventEmitter['emit'];
  return engine;
}
