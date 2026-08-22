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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  // ── WP3 C13 (2026-08-18) → LM-CAT (2026-08-22): the production case moved ──
  //
  // ⚠️ THIS CASE PINNED GERMAN FOR ONE ERA, and the change is the delivery:
  // WP3's gate asked the ONE model, so 'de' refused at the factory. LM-CAT
  // gives 'de' downloadable catalog rows, so 'de' now constructs and refuses
  // (or serves) at open() depending on what is on disk. The spawn-time
  // factory refusal this case exists to prove now needs a language NO
  // catalog row claims — Italian.
  it('🔴 REAL factory chain: a seeded wildcard row routes an uncovered language to '
    + 'the built-in engine, the catalog refusal fires at spawn, and the phone gets the coded frame', async () => {
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
          (): SttEngine => router.pickEngine('it', seeded, defaultEngineFactory),
          { engineFlushTimeoutMs: 50 },
        ),
        isByok: false,
        gated: false,
      }),
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u-cold-open-it', mode: 'realtime', sourceLang: 'it',
      onComplete: () => {},
    });
    await settle();
    const errs = emitted.filter((e) => e.event === 'stt:error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.payload).toMatchObject({ code: 'STT_LANGUAGE_UNSUPPORTED', retryable: false });
    expect((errs[0]!.payload as { message: string }).message).toContain('it');
    // 🔴 The diagnostic message is the half that reaches a support log, and it
    // must have moved with the code — a frame whose code and message disagree
    // is worse than either alone, because only one of them is ever read.
    expect((errs[0]!.payload as { message: string }).message).toContain('cannot recognise');
    await expect(bridge.finish()).resolves.toBeUndefined();
  });

  // ── LM-CAT §6-3: covered-but-not-downloaded refuses at OPEN, as CONFIG_MISSING ──
  it('🔴 German with no pack on disk reaches the phone as STT_CONFIG_MISSING — the '
    + '"go download it in Settings" refusal, not the "physically cannot" one', async () => {
    // Deterministic disk: point the app-data roots at an empty temp dir so
    // this machine's real model installs cannot leak into the verdict.
    const empty = mkdtempSync(join(tmpdir(), 'flowmic-cold-open-appdata-'));
    const savedAppData = process.env['APPDATA'];
    const savedXdg = process.env['XDG_DATA_HOME'];
    const savedOverride = process.env['FLOWMIC_SHERPA_MODEL_DIR'];
    const savedAuto = process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'];
    process.env['APPDATA'] = empty;
    process.env['XDG_DATA_HOME'] = empty;
    delete process.env['FLOWMIC_SHERPA_MODEL_DIR'];
    delete process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'];
    try {
      const seeded: Routing[] = [
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
      expect(errs.length).toBeGreaterThanOrEqual(1);
      expect(errs[0]!.payload).toMatchObject({ code: 'STT_CONFIG_MISSING', retryable: false });
      // The sentence names the user's actual exit (Settings), never an env var.
      expect((errs[0]!.payload as { message: string }).message).toContain('Settings');
      await expect(bridge.finish()).resolves.toBeUndefined();
    } finally {
      if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData;
      if (savedXdg === undefined) delete process.env['XDG_DATA_HOME']; else process.env['XDG_DATA_HOME'] = savedXdg;
      if (savedOverride === undefined) delete process.env['FLOWMIC_SHERPA_MODEL_DIR']; else process.env['FLOWMIC_SHERPA_MODEL_DIR'] = savedOverride;
      if (savedAuto === undefined) delete process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD']; else process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'] = savedAuto;
    }
  });
});
