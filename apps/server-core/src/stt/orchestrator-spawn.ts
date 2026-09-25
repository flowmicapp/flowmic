// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (engine reconnect ladder), §3 (spawn/flush timeout)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `orchestrator-core.ts` went over the 800-line cap when the RC-1/RC-7 and
// RC-4/RC-5 relay branches were merged (integ/next-release, 2026-09-24; D-14).
// The block moved here is the OPEN step of `spawnEngine`: the NR-38 `loading`
// frame, the NR-96 attempt-generation guard and the RC-1/RC-7 superseded-leg
// checks. It is a VERBATIM structural split, not a rewrite: every comment below
// carries the same reasoning it carried inside the class, only the receiver
// changed from `this` to `host` (the same shape as orchestrator-rollover.ts /
// orchestrator-terminal.ts). `spawnEngine` keeps everything else, and calls
// {@link openLeg} at the exact point this block used to sit.

import { isLocalModelEngine, type EngineSubscriber } from './orchestrator-types';
import { SupersededLegError, type EngineSessionReconnectLadder } from './engine-session';

/** What the open step reads and writes on the orchestrator. Satisfied by passing
 *  the orchestrator itself through a cast (see `asRolloverHost` for the idiom). */
export interface SpawnOpenHost {
  engine: EngineSubscriber | null;
  engineOpening: boolean;
  spawnGeneration: number;
  readonly ladder: EngineSessionReconnectLadder;
  closeEngine(): Promise<void>;
  emit(event: 'engine-status', payload: { provider: string; status: 'loading' }): boolean;
}

/** The open step of `spawnEngine` (orchestrator-core.ts), moved VERBATIM. */
export async function openLeg(host: SpawnOpenHost, engine: EngineSubscriber, coldOpen: boolean): Promise<void> {
  if (typeof engine.open === 'function') {
    // 🔴 NR-38 — THE COLD SECONDS, SPOKEN. A local model engine's `open()` is a
    // MODEL LOAD, not a dial: 1.9 s (SenseVoice, 229 MB) to 8 s
    // (whisper-turbo, 1.03 GB) of reading the pack off disk and building the
    // recogniser, measured on dev-pc-a / the ledger §25 runs. Until this line
    // the first frame the user could ever see was the `ready` AFTER that wait,
    // so the product's answer to "I pressed the button and nothing happened"
    // was silence. It goes out BEFORE `await engine.open()` deliberately —
    // after it, it would be an announcement of a wait that is already over.
    //
    // Scoped twice, and both halves are load-bearing:
    //  - `coldOpen`, because only this path emits the closing `ready`;
    //  - `isLocalModelEngine`, because a dialled engine opens in milliseconds
    //    and a `loading` there is a flicker with no information in it.
    // On failure the cold-open catch in `start()` emits `failed`, so every
    // `loading` is closed by exactly one of the two (pinned in
    // test/stt-local-cold-open-loading.test.ts).
    if (coldOpen && isLocalModelEngine(engine.id)) {
      host.emit('engine-status', { provider: engine.id, status: 'loading' });
    }
    host.engineOpening = true;
    // 🔴 NR-96 — attempt-generation guard. A spawn raced by `raceSpawnTimeout`
    // (ladder rung, `dialLeg`, rollover, cold open) is ABANDONED when the cap
    // fires: the caller closes this engine and may already have spawned the
    // next one before this `open()` finally rejects. Without the guard, this
    // late catch closed `host.engine` — the NEWER attempt's live leg — and
    // this late `finally` cleared the newer attempt's `engineOpening`. So each
    // attempt only ever tears down what it still owns.
    // Pinned by test/engine-reconnect-stale-spawn.test.ts.
    const generation = ++host.spawnGeneration;
    try {
      await engine.open();
    } catch (err) {
      // card RC-1 — still OUR leg ⇒ a real refusal: close it, hand the error on. Not ours any more (somebody
      // closed or replaced it while it opened) ⇒ not a failure at all; see SupersededLegError.
      if (host.engine !== engine) throw new SupersededLegError(err);
      await host.closeEngine();
      throw err;
    } finally {
      if (generation === host.spawnGeneration) host.engineOpening = false;
    }
    // 🔴 card RC-7 — a leg that finished opening AFTER it was superseded or AFTER the ladder gave up must not
    // take the session back (the phone already holds 「session terminated」; a revived leg would feed, emit
    // interims and hand udio:stop a normal final — two answers to 「is it dead」, R11). Close it, arm
    // nothing, recheck nothing. Pinned by test/engine-reconnect-stale-spawn.test.ts.
    if (host.engine !== engine || host.ladder.gaveUp) {
      if (host.engine === engine) await host.closeEngine(); else try { await engine.close(); } catch { /* already closed by whoever superseded it */ }
      throw new SupersededLegError();
    }
  }
}
