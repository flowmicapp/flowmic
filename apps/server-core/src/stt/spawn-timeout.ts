// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (spawn/flush timeout — F-2097
//     raceSpawnTimeout; no silent failure: cannot reach the engine → terminal stt:error)
//   Ported from legacy stt/spawn-timeout.ts (mechanism kept as-is).
//
// The orchestrator races engine.open() against this cap; a SpawnTimeoutError
// (or any other open() rejection) is a terminal connect failure →
// engine-status{failed} + STT_NETWORK_DROP.

/** Raised when engine.open() exceeds its spawn-timeout cap. */
export class SpawnTimeoutError extends Error {
  constructor(ms: number) { super(`engine spawn timeout after ${ms}ms`); this.name = 'SpawnTimeoutError'; }
}

/** Race a spawn `work` promise against `ms`; reject with SpawnTimeoutError if
 *  the cap fires first. Timer fns are injected so FakeClock tests stay
 *  deterministic. */
export function raceSpawnTimeout<T>(
  work: Promise<T>,
  ms: number,
  setTimeoutFn: (fn: () => void, ms: number) => unknown,
  clearTimeoutFn: (handle: unknown) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = setTimeoutFn(() => reject(new SpawnTimeoutError(ms)), ms);
    work.then((v) => { clearTimeoutFn(h); resolve(v); }, (e) => { clearTimeoutFn(h); reject(e); });
  });
}
