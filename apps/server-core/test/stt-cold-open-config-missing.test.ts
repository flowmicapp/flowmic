// card K-7 — the ONE cold-open failure that was swallowed AND reported as success.
//
// ── THE STRUCTURE, which is what this file pins ──────────────────────────────
// `SttEngineOrchestrator.start()` narrates every spawn failure on its own
// 'error' event (→ `stt:error` via SttSessionBridge.wireEvents) and then
// rethrows — every failure BUT ONE. The router's `SttConfigMissingError` is
// rethrown BEFORE those two emits:
//
//     if (err instanceof SttConfigMissingError) throw err;   // orchestrator-core.ts
//
// on the premise its own comment stated: 「propagates raw (audio.handler maps
// it)」. That premise CANNOT hold, and had not held since the bridge started
// firing `start()` and forgetting it:
//
//     this.startPromise = this.orchestrator.start(input).catch(() => undefined);
//
// Nothing awaits `startPromise` at construction time, and by the time it
// rejects, `audio.handler` has already run `safeAck(ack, { ok: true })`. So the
// account with no engine for its language got: no frame, no log line, and a
// success ack. A silent swallow and a false success at the same time — both
// halves of the red line, on the failure whose entire job is to say what is
// missing.
//
// ⚠️ HONEST SCOPE. That the structure is a silent swallow is PROVEN by the two
// lines above and by this file. Whether a live input can actually make the
// SPAWN-time router disagree with the pre-check `audio.handler` already passed
// (stt/engine-factory.ts) is UNVERIFIED — no production trace of this path
// exists. This is a hole closed on structural grounds, not an observed failure
// reproduced.
// 🔴 In-place correction (WP3 C13, 2026-08-18): the paragraph above is no
// longer the whole truth — there IS a production input now. The factory's
// sherpa-local arm refuses a language the SenseVoice model cannot recognise
// (fr/es/de/ru, all reachable from the phone's grown spoken picker), so on any
// self-hosted box the seeded `'*'` row selects fine and the SPAWN-time factory
// throws. The last test in this file drives that exact chain — real router,
// real factory, no stub — and K-7's rethrow is what carries it to the phone.
// The original paragraph stays because it was true when written and it is why
// this hole was closed BEFORE the input existed.
//
// ── WHY THE FAILURE IS INJECTED AT THE ENGINE FACTORY ────────────────────────
// Because that is where it comes from in production. `spawnEngine()` calls
// `this.engineFactory()`, which is exactly where the per-language router runs;
// a throw there rejects the spawn, and the `instanceof` arm above rethrows it
// raw. The test drives the REAL orchestrator through the REAL rethrow — a
// stubbed `start()` that just rejects would only be testing the `.catch`.

import { describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { makeEngineRouter, SttConfigMissingError, type Routing } from '../src/stt/engine-router';
import { defaultEngineFactory } from '../src/stt/engine-factory';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngine } from '../src/stt/engines/base';

interface Cap { event: string; payload: unknown }

/** A bridge whose engine factory throws the router's error at SPAWN time —
 *  i.e. asynchronously, inside `orchestrator.start()`, after the constructor
 *  has already returned an object the handler will ack `{ok:true}` for. */
function bridgeWithConfigMissingSpawn(): { emitted: Cap[]; bridge: SttSessionBridge } {
  const emitted: Cap[] = [];
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => ({
      orchestrator: new SttEngineOrchestrator(
        session,
        (): SttEngine => { throw new SttConfigMissingError('ko'); },
        { engineFlushTimeoutMs: 50 },
      ),
      isByok: false,
      gated: false,
    }),
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u-cold-open', mode: 'realtime', sourceLang: 'ko',
    onComplete: () => {},
  });
  return { emitted, bridge };
}

/** A real macrotask: the rejection travels through a fire-and-forget promise,
 *  so a microtask flush would observe the moment BEFORE the defect, not after. */
const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('K-7: an async cold-open SttConfigMissingError reaches the phone', () => {
  it('emits exactly one stt:error{STT_CONFIG_MISSING}, where there used to be nothing', async () => {
    const { emitted } = bridgeWithConfigMissingSpawn();
    await settle();
    const errs = emitted.filter((e) => e.event === 'stt:error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.payload).toMatchObject({ code: 'STT_CONFIG_MISSING', retryable: false });
  });

  it('the message names the language — the one fact that makes it actionable', async () => {
    const { emitted } = bridgeWithConfigMissingSpawn();
    await settle();
    const err = emitted.find((e) => e.event === 'stt:error')!.payload as { message: string };
    expect(err.message).toContain('ko');
  });

  it('retryable:false — the phone acts only on a terminal frame (ptt_inbound.dart)', async () => {
    const { emitted } = bridgeWithConfigMissingSpawn();
    await settle();
    const err = emitted.find((e) => e.event === 'stt:error')!.payload as { retryable: boolean };
    // A `true` here is a frame the phone receives and deliberately ignores,
    // i.e. the same silence one layer further along.
    expect(err.retryable).toBe(false);
  });

  it('the rejection is still absorbed — a config gap must not become an unhandled rejection', async () => {
    // The old `.catch(() => undefined)` was doing ONE useful thing, and the
    // replacement must keep it. If this regressed, the process-level handler
    // would fire rather than this assertion, so the row is deliberately shaped
    // as "the run completes normally".
    const { bridge } = bridgeWithConfigMissingSpawn();
    await settle();
    await expect(bridge.finish()).resolves.toBeUndefined();
  });

  // ── WP3 C13 (2026-08-18): the header's 「UNVERIFIED」 now has a production case ──
  it('🔴 REAL factory chain: a seeded wildcard row routes German to the built-in '
    + 'engine, the model refusal fires at spawn, and the phone gets the coded frame', async () => {
    // This file's header records that no production input was known to make
    // the spawn-time factory disagree with the pre-check the handler passed.
    // There is one now: selection legitimately matches the seeded `'*'` row
    // (the wildcard IS the general-purpose entry), and the FACTORY then
    // refuses because the SenseVoice model cannot recognise the language
    // (measured: German in → 「.」 out, clean exit). No stub throw here — the
    // real router, the real factory, the real refusal.
    const seeded: Routing[] = [
      { language: 'zh', engine_id: 'sherpa-local', provenance: 'seed' },
      { language: '*', engine_id: 'sherpa-local', provenance: 'seed' },
    ];
    const router = makeEngineRouter({});
    const emitted: Cap[] = [];
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(
          session,
          (): SttEngine => router.pickEngine('de', seeded, defaultEngineFactory),
          { engineFlushTimeoutMs: 50 },
        ),
        isByok: false,
        gated: false,
      }),
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u-cold-open-de', mode: 'realtime', sourceLang: 'de',
      onComplete: () => {},
    });
    await settle();
    const errs = emitted.filter((e) => e.event === 'stt:error');
    expect(errs).toHaveLength(1);
    // ⚠️ This read `STT_CONFIG_MISSING` for one round — the nearest TRUE code,
    // shipped while the precise one was owner-pending (granted 2026-08-17).
    // What this test proves is unchanged and is the reason it exists: the
    // refusal survives the REAL chain and reaches the phone as ONE coded frame,
    // with `retryable:false` so nothing retries a mismatch that cannot heal.
    expect(errs[0]!.payload).toMatchObject({ code: 'STT_LANGUAGE_UNSUPPORTED', retryable: false });
    expect((errs[0]!.payload as { message: string }).message).toContain('de');
    // 🔴 The diagnostic message is the half that reaches a support log, and it
    // must have moved with the code — a frame whose code and message disagree
    // is worse than either alone, because only one of them is ever read.
    expect((errs[0]!.payload as { message: string }).message).toContain('cannot recognise');
    await expect(bridge.finish()).resolves.toBeUndefined();
  });
});
