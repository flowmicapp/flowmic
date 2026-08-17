// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (SttEngineId → constructor; one
//     orchestrator instance per recording), §4 (reads settings stt.routings,
//     re-resolved on every audio:start; BYOK determination = the matched
//     routing's api_key is user-supplied and non-empty, 'EMPTY' counts as a
//     platform endpoint), §5 (hotwords)
//   docs/strategy/2026-07-23-lan-model-defaults.md (referenced by preset id; the
//     code adds no new
//     hardcoded IP — the default comes from the preset seeded by settings.defaults)
//   CLAUDE.md red line: the singular stt.routing key must never come back to
//     life; no implicit fallback
//   Adapted from legacy stt/orchestrator-factory.ts (mechanism kept as-is).
//
// "settings → routings → orchestrator" glue + the engine-id → ctor switch. Each
// call loads the user's stt.routings snapshot (node:sqlite settings repo is
// synchronous) and builds one SttEngineOrchestrator whose sync engine factory
// closes over it — pickEngine runs at spawn time (start / soft-segment /
// reconnect) so a settings update takes effect on the next segment.

import { createRequire } from 'node:module';
import type { ServerMode, SttEngineId } from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { isByokEnabled } from '../settings/byok';
import { isSeedMarked } from '../settings/provenance';
import { resolveReplacementRules } from '../compose/scenario-context';
import type { SttEngine, SttEngineConfig } from './engines/base';
import { SttEngineError, unexpectedCloseError } from './engines/base';
import {
  makeEngineRouter, selectRoutingWithSource, SttConfigMissingError,
  type EngineFactory, type Routing, type SelectedRouting,
} from './engine-router';
import { makePoolManagedDefault } from './pool-routing';
import { isStreamingEngine } from './streaming-engines';
import { buildHotwords, type SttDictionaryEntry } from './hotwords';
import { SttEngineOrchestrator } from './orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS, type OrchestratorOptions } from './orchestrator-types';
import type { AudioSession } from './audio/session';
import type { VadGate } from './vad-gate';
import { FunasrEngine } from './engines/funasr';
import { DeepgramEngine } from './engines/deepgram';
import { OpenAiRealtimeEngine } from './engines/openai-realtime';
import { OpenAiWhisperEngine } from './engines/openai-whisper';
import { CustomOpenAiCompatibleEngine } from './engines/custom-openai-compatible';
import { FunspeechHttpEngine } from './engines/funspeech-http';
import { SherpaLocalEngine } from './engines/sherpa-local';

/** Module specifier for the PRIVATE cloud-STT adapters (H6/P2). Held in a
 *  variable, and loaded through `createRequire`, for one specific reason:
 *  **esbuild cannot statically follow a non-literal specifier**, so this package
 *  is never pulled into the desktop Tauri sidecar bundle
 *  (`apps/desktop/scripts/build-sidecar.mjs` runs esbuild with `bundle:true` —
 *  a literal `import('@flowmic/stt-cloud')` WOULD be inlined by it, dynamic or
 *  not). Same idiom as `sherpa-local.ts` / `db/connection.ts`.
 *  The env override exists for deployments that install the package outside the
 *  workspace layout; absent → the bare workspace name. */
function cloudSpecifier(): string {
  // Read per call, not once at module load: the env is set by the deployment and
  // module-load order is not something this file gets to assume. (It also makes
  // the loader testable against a fixture, which is the only way the SUCCESS
  // path of an optional load can be proven at all.)
  return process.env.FLOWMIC_STT_CLOUD_MODULE ?? '@flowmic/stt-cloud';
}
const cloudRequire = createRequire(import.meta.url);

/** Shape of the private package, expressed in SERVER-CORE's own types — so if
 *  `packages/stt-cloud/src/host.ts` drifts from `engines/base.ts`, the drift
 *  shows up as a type error at the `createEngine(...)` call below. */
interface CloudEngineModule {
  createEngine(
    id: SttEngineId,
    cfg: SttEngineConfig,
    host: { SttEngineError: typeof SttEngineError; unexpectedCloseError: typeof unexpectedCloseError },
  ): SttEngine;
}

/**
 * Load a cloud (private, closed-source) engine, or throw BY NAME.
 *
 * 🔴 FAIL-LOUD IS THE ENTIRE POINT. An optional dynamic load that silently
 * no-ops is this repo's #1 bug shape, and here the silent version would be
 * catastrophic in a specific way: it would fall back to *some other engine* and
 * the user would be transcribed by a vendor nobody chose. So there is NO
 * fallback path — a self-hosted build that somehow reaches `engine_id:'soniox'`
 * gets an exception naming the id, the specifier, and the reason. Paradigm
 * copied from `managed-default.ts` (ENABLED-but-invalid throws at startup).
 */
export function requireCloudEngine(id: SttEngineId, cfg: SttEngineConfig): SttEngine {
  const spec = cloudSpecifier();
  let mod: CloudEngineModule;
  try {
    mod = cloudRequire(spec) as CloudEngineModule;
  } catch (err) {
    throw new Error(
      `SttEngine '${id}' requires the private package '${spec}', which is not installed in this build. `
      + 'This is EXPECTED in a self-hosted / open-source build: cloud vendor adapters are not part of it '
      + '(owner 2026-08-02 H1 + H3). Configure a local engine instead. '
      + `Underlying load error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof mod?.createEngine !== 'function') {
    // The module resolved but is not the thing we expected. Saying so beats
    // `undefined is not a constructor` three frames later.
    throw new Error(`'${spec}' loaded but exports no createEngine() — cannot build SttEngine '${id}'`);
  }
  return mod.createEngine(id, cfg, { SttEngineError, unexpectedCloseError });
}

/**
 * Concrete engine-id → constructor switch. Each bundled engine has exactly one
 * production reference, here — so a `grep <EngineName>` from the repo root
 * surfaces the wiring chain (anti-façade). Covers the six protocol engines +
 * the 7th built-in `sherpa-local` + the private cloud engines (loaded, not
 * bundled).
 *
 * ⚠️ The `_exhaustive: never` default is an ASSET, not boilerplate: it is the
 * only landing point in card §4 that the compiler catches. Adding a registry
 * must not
 * dismantle it — that is exactly why B15 chose option (a) (name in the union)
 * over (b) (separate opaque id space).
 */
export const defaultEngineFactory: EngineFactory = (
  id: SttEngineId,
  cfg: SttEngineConfig,
): SttEngine => {
  switch (id) {
    case 'funasr':                   return new FunasrEngine(cfg);
    case 'deepgram':                 return new DeepgramEngine(cfg);
    case 'openai-realtime':          return new OpenAiRealtimeEngine(cfg);
    case 'openai-whisper':           return new OpenAiWhisperEngine(cfg);
    case 'custom-openai-compatible': return new CustomOpenAiCompatibleEngine(cfg);
    case 'funspeech-http':           return new FunspeechHttpEngine(cfg);
    case 'sherpa-local':             return new SherpaLocalEngine(cfg);
    case 'soniox':                   return requireCloudEngine(id, cfg);
    default: {
      const _exhaustive: never = id;
      throw new Error(`UnknownSttEngineId: ${String(_exhaustive)}`);
    }
  }
};

/** 🔴 MOVED to `./streaming-engines` 2026-08-02 (L2) to break a module cycle —
 *  the pool layer needs this answer and this file now imports the pool layer.
 *  RE-EXPORTED here so every existing importer (`http/probe-routes.ts`,
 *  `stt/batch-transcribe.ts`, tests) is untouched. The §4a trap warning moved
 *  with the code; read it there. */
export { STREAMING_ENGINES, isStreamingEngine } from './streaming-engines';

/** Load the user's stt.routings snapshot. Empty/absent → [] (the router then
 *  surfaces SttConfigMissingError per #16). The legacy singular `stt.routing`
 *  key is intentionally NOT read (CLAUDE.md red line: the singular key must
 *  never come back to life).
 *
 *  settings-key-drift GET ANCHOR (decision 2026-07-23-settings-key-drift-literal-
 *  anchors): WP-R2-2 gives the desktop a real UI SET face for `stt.routings`
 *  (`updateSetting('stt.routings')` in apps/desktop/src/lib/settings-client.ts).
 *  This is the REAL server read point for the key (engine-router.ts named in the
 *  ruling takes routings as a param and reads no settings — the settings read
 *  happens here), so the literal-keyed `readSetting('stt.routings')` GET anchor
 *  lives here to pair with the desktop SET anchor. The literal has no protocol
 *  constant; it is pinned equal to the desktop set key in settings-anchors.test.ts. */
export function loadRoutings(settings: SettingsRepo, userId: string): Routing[] {
  const readSetting = (key: string): SettingRow | null => settings.read(userId, key);
  const row = readSetting('stt.routings');
  const value = row?.value;
  const all = Array.isArray(value) ? (value as Routing[]) : [];
  // Explicit `stt.byok_enabled === false` (SaaS register / console toggle)
  // drops user-authored rows so traffic falls through to the managed default.
  // Seed rows stay: standalone has no managed default and still needs them.
  // Absent key ⇒ unchanged (isByokEnabled is true).
  if (!isByokEnabled(settings, userId)) return all.filter((r) => isSeedMarked(r));
  return all;
}

/**
 * Build the FunASR open-frame hotwords JSON-string from the user's preferred
 * terminology (undefined when there is nothing → the open frame stays
 * baseline-identical).
 *
 * 🔴 The source is `resolveReplacementRules` — the SAME three-source merge the
 * LLM-reference block and the deterministic replacer already use (card terms ∪
 * dictionary packs ∪ stt.dictionary). It used to read `stt.dictionary` ALONE,
 * which is the narrowest of the three, and the consequence landed on the primary
 * persona: a MOBILE user's custom terms UI writes exclusively to
 * `scenario.card.terms`, and the phone has no way to reach `stt.dictionary` at
 * all — so their terminology never reached any engine. Dictionary packs never
 * reached an engine from any client either. (This is NOT "a source with no write
 * surface": `stt.dictionary` does have a mounted desktop UI. It is "engine
 * biasing read the narrowest source".)
 *
 * Threading cost: zero. This function already had exactly the two arguments
 * `resolveReplacementRules` takes, of identical type, and its one call site
 * already passes them. No import cycle: `stt/` already imports `compose/` and
 * `compose/` never imports `stt/`.
 *
 * MERGE ORDER + CAP, stated as decisions rather than left as accidents:
 *  • Order is card terms → packs → stt.dictionary, inherited verbatim from
 *    resolveReplacementRules so the two consumers can never disagree about what
 *    "the user's terminology" is.
 *  • `buildHotwords` truncates at HOTWORDS_MAX_ENTRIES (300) from the FRONT, so
 *    the earlier legs win a collision with the cap. Worst case ahead of the
 *    user's personal list is card terms ≤100 (protocol SCENARIO_MAX_TERMS) +
 *    all six curated packs enabled at once = 66 ⇒ ≤166. The personal dictionary
 *    therefore keeps at least 134 slots even in the worst configuration.
 *    (66, not the 67 you get by adding the pack lengths up: `composeDictionary`
 *    dedupes by term and `GitHub` ships in BOTH tech-dev and proper-noun. Both
 *    numbers are MEASURED and pinned by a test rather than left to arithmetic in
 *    a comment — see test/hotwords.test.ts, which recomputes them from the
 *    packs so growth in the curated content cannot rot this line silently.)
 *  • That 300 counts ACCEPTED INPUT ENTRIES, not distinct output keys
 *    (`hotwords.ts` increments its counter on every accepted entry, including
 *    one whose term repeats). Duplicates across legs are now possible (the same
 *    term may sit in the card AND a pack), so input-count and key-count can
 *    differ. Kept deliberately: the cap exists to bound what we hand the FST,
 *    and re-deriving it from output keys would change a shipped, tested rule for
 *    no engine-side benefit.
 *  • Last write wins on a duplicate term, so an `stt.dictionary` weight beats a
 *    pack weight for a colliding term — the user's own entry is the more
 *    specific authority, and it is the later leg.
 */
export function loadHotwords(settings: SettingsRepo, userId: string): string | undefined {
  // Fails LOUD on a present-but-malformed scenario.card (SETTINGS_SCHEMA_INVALID),
  // same contract as every other reader of this resolver. This runs inside the
  // synchronous factory closure the audio handler invokes in its try, so the
  // throw already surfaces as stt:error with no new plumbing.
  const rules = resolveReplacementRules(settings, userId);
  const entries: SttDictionaryEntry[] = rules.map((r) => ({
    term: r.canonical,
    ...(r.weight !== undefined ? { weight: r.weight } : {}),
  }));
  return buildHotwords(entries);
}

/** Wrap an EngineFactory so FunASR engines carry the resolved hotwords. No-op
 *  when hotwords is undefined; non-FunASR engines pass through untouched.
 *
 *  ⚠️ Deliberately still FunASR-ONLY after loadHotwords was widened to the full
 *  three-source merge. Widening the SOURCE (which terms we know about) and
 *  widening the DESTINATION (which engines get told) are two separate decisions;
 *  only the first was made here. Carrying terminology to any other vendor's
 *  biasing API is an owner call, not a tidy-up. */
function withHotwords(inner: EngineFactory, hotwords: string | undefined): EngineFactory {
  if (hotwords === undefined) return inner;
  return (id, cfg) => inner(id, id === 'funasr' ? { ...cfg, hotwords } : cfg);
}

/**
 * BYOK judgement (06 §4): the matched routing's api_key is USER-supplied and
 * non-empty; the LLM sentinel 'EMPTY' (vLLM Bearer) counts as a platform
 * endpoint, NOT BYOK. Platform managed default → not BYOK → counts toward quota
 * / is billed, **however many characters its key has**. BYOK usage is uncounted.
 *
 * 🔴 T7 (card §-0f, fixed 0.2.4x). The criterion used to be "whether there is a key":
 *
 *     const k = routing?.api_key;
 *     return typeof k === 'string' && k.length > 0 && k !== 'EMPTY';
 *
 * and its own comment defended it with the parenthetical "Managed default + LAN
 * presets **(empty key)**". That parenthetical was the whole load-bearing
 * assumption, and it is not a property of the managed default — it is a property
 * of the ONE managed default we happened to have deployed (FunASR, keyless).
 * `managed-default.ts:39` has always copied `FLOWMIC_MANAGED_STT_API_KEY` onto
 * the routing, so ANY keyed managed engine (deepgram today, soniox next) flipped
 * this to `true` and thereby: ① `recordSttUsage(is_byok:true)` returns early ⇒
 * no `usage_records` row is ever written ⇒ the quota guard reads `used=0` forever
 * (it is not BYOK-aware — it is STARVED, not disabled: `quota-guard.ts:51-67`);
 * ② `gated` at the call site below goes false ⇒ silence is streamed to a
 * per-second-billed vendor. Both are money.
 *
 * ⚠️ This was never a Soniox bug. The managed-default feature has not been
 * billable for any keyed engine since it was written; it stayed dormant only
 * because production ran the keyless FunASR default. **Do not narrow this back
 * to a key-shape test** — the question is "who supplied it", and only the
 * selection step
 * knows that, which is why the argument is a `SelectedRouting` and not a
 * `Routing`: a caller physically cannot ask without stating provenance.
 */
export function resolveByok(selected: SelectedRouting | null): boolean {
  if (!selected || selected.source !== 'user') return false;
  const k = selected.routing.api_key;
  return typeof k === 'string' && k.length > 0 && k !== 'EMPTY';
}

export interface BuiltOrchestrator {
  orchestrator: SttEngineOrchestrator;
  /** Whether this session's matched engine is BYOK (06 §4) — threaded to the
   *  usage tracker so BYOK sessions stay uncounted. */
  isByok: boolean;
  /** True when the VAD gate governs this session's engine feed (managed
   *  streaming) — the bridge then bills the gated session ms, not raw audio. */
  gated: boolean;
}

export interface SttOrchestratorFactoryDeps {
  settings: SettingsRepo;
  mode: ServerMode;
  /** Test seam: override the id → ctor switch. Production passes nothing. */
  engineFactory?: EngineFactory;
  orchestratorOptions?: OrchestratorOptions;
  /** Managed default resolver. Defaults to the POOL-backed one (A6-3) — see the
   *  note in {@link makeSttOrchestratorFactory}. Tests inject their own. */
  managedDefault?: (language: string) => Routing | null;
}

/**
 * Build the production orchestrator factory. Each invocation loads the user's
 * stt.routings (+ hotwords) snapshot and returns a fresh orchestrator plus the
 * session's BYOK flag. When a `vad` gate is supplied AND the matched engine is
 * a MANAGED (non-BYOK) STREAMING engine, the orchestrator only feeds the engine
 * while the gate is open — silence never accrues billed session time (§2.3).
 */
export function makeSttOrchestratorFactory(
  deps: SttOrchestratorFactoryDeps,
): (session: AudioSession, language: string, userId: string, vad?: VadGate) => BuiltOrchestrator {
  const engineFactory = deps.engineFactory ?? defaultEngineFactory;
  // 🔴 A6-3 WIRING (2026-08-02, L2). The managed default is now resolved BY THE
  // POOL — `makePoolManagedDefault` → `resolvePoolRouting` → `selectRoute`. This
  // is the production consumer that closes M2-2 for O-5; before it, the selection
  // algorithm had 31 green unit tests and zero callers, which is this repo's #1
  // shape (a capability is defined, and nobody calls it).
  //
  // ⚠️ It is NOT an added condition: with no `FLOWMIC_STT_POOL` configured the
  // pool loader WRAPS the single env-gated `managedDefaultRouting()` as a
  // one-route pool, so `selectRoute` runs on every managed session regardless,
  // and the resolved routing is byte-identical to what the old call returned.
  // The visible difference is one forensic line per selection — including
  // `candidates:1`, which is exactly the degenerate state card §-0b says must not
  // be reportable as "smart routing selection has been implemented".
  const managedDefault = deps.managedDefault
    ?? makePoolManagedDefault({ factory: engineFactory }).resolve;
  return (session, language, userId, vad) => {
    const routings = loadRoutings(deps.settings, userId);
    const hotwords = loadHotwords(deps.settings, userId);
    const factory = withHotwords(engineFactory, hotwords);
    const router = makeEngineRouter({ managedDefault });
    // #16 fail-fast: no matching routing → throw synchronously so the sync
    // sttFactory call surfaces stt:error (no implicit fallback engine).
    // 🔴 T7: WithSource, not the plain `selectRouting` — the two lines below are
    // the billing decisions, and they need "who supplied the key", not "whether
    // there is a key".
    const selected = selectRoutingWithSource(language, routings, managedDefault);
    if (!selected) throw new SttConfigMissingError(language);
    const isByok = resolveByok(selected);
    const gated = vad !== undefined && !isByok && isStreamingEngine(selected.routing.engine_id);
    // 🔴 card RT-2 — `gated` is ALSO the answer to "is this leg billed by the
    // second", and both consequences hang off it here rather than being
    // re-derived downstream: feed only while the gate is open, AND hang the leg
    // up once the voice has been absent for `DEFAULT_ENGINE_IDLE_HANGUP_MS`.
    // The orchestrator is TOLD, never left to infer it from the presence of
    // `shouldFeedEngine` — see that option's doc for why that inference is the
    // repo's #1 shape (one value answering two questions).
    //
    // ⚠️ SPREAD ORDER IS UNCHANGED — the gated pair still lands LAST and still
    // wins over `deps.orchestratorOptions`. Flipping it so a caller could pin
    // `idleHangupMs` would silently also let a caller override the BILLING gate
    // `shouldFeedEngine`, which nothing has ever been allowed to do.
    const options: OrchestratorOptions = {
      ...(deps.orchestratorOptions ?? {}),
      ...(gated ? { shouldFeedEngine: (): boolean => vad!.open, idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS } : {}),
    };
    const orchestrator = new SttEngineOrchestrator(
      session,
      () => router.pickEngine(language, routings, factory),
      options,
    );
    return { orchestrator, isByok, gated };
  };
}
