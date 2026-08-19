// SPEC-REF:
//   docs/strategy/R1-TASK-CARDS.md WP-R1-4 (compose + scenario pipeline)
//   apps/server-core/src/socket/handlers/compose.handler.ts (the mount point —
//     calls deps.composeFactory per compose:start)
//   apps/server-core/src/bootstrap.ts (the WIRING ROOT — the controller wires
//     `composeFactory: createComposeFactory({ settings: db.settings, usage:
//     usageTracker })` into registerComposeHandlers; this module never imports
//     bootstrap)
//
// The compose subsystem's public surface. createComposeFactory closes over the
// SettingsRepo and returns the per-compose:start factory the handler expects:
// each call resolves the LLM config + three-source scenario context from that
// user's settings, assembles the stable-prefix system prompt, and returns a
// ComposeRun that streams the turn (fail-loud on LLM failure — never reinjects
// raw STT text).

import type { ComposeOrchestrator } from '../engine/orchestrator';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { UsageTracker } from '../billing/usage-tracker';
import { streamerFor as defaultStreamerFor, type LlmStreamer } from './llm';
import { resolveLlmConfigWithSource, resolveByokLlm } from './llm-config';
import { resolveScenarioContext, resolveReplacementRules } from './scenario-context';
import { buildScenarioBlock } from './scenario';
import { renderSystemPrompt } from './prompt';
import { createComposeRun } from './orchestrator';
import { buildDictionaryReplacer } from './dictionary-replace';
import { COMPOSE_BUDGET_MS } from './mode';
import { ScenarioInferenceStore, type ScenarioInferenceSeams } from './scenario-infer-store';

/** Args the compose handler passes per compose:start. `processName` is the
 *  focus-target seam (source ②) — optional, unset until desktop focus tracking
 *  is wired (see app-category.ts). */
export interface ComposeStartArgs {
  userId: string;
  task: 'translate' | 'organize' | 'draft_polish';
  sourceText: string;
  sourceLang?: string;
  targetLang?: string;
  processName?: string;
}

export interface ComposeFactoryDeps {
  settings: SettingsRepo;
  /**
   * M6 (0.3.0 task book): the LLM meter, for the scenario-inference call — the
   * one LLM path that ran completely unmetered (scenario-infer-call.ts, 8 s
   * budget, platform key under the managed default). REQUIRED, not defaulted:
   * a defaulted no-op meter is this repo's #1 façade class (a dial that cannot
   * move), so the compiler forces every constructor — bootstrap passes the real
   * tracker, tests state their noop explicitly.
   */
  usage: Pick<UsageTracker, 'recordLlmUsage'>;
  /** Injectable fetch (LAN smoke / tests). Defaults to node-native fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable streamer dispatcher (tests). Defaults to the protocol dispatch. */
  streamerFor?: (protocol: 'openai-compatible' | 'anthropic') => LlmStreamer;
  /** Per-turn LLM budget (ms). Defaults to COMPOSE_BUDGET_MS. */
  budgetMs?: number;
  /**
   * V2-08 seams only — clock, scheduler, log sink, bounds. The store itself is
   * ALWAYS constructed below, so production and tests run the same construction
   * path and there is no configuration in which the scenario-inference wiring
   * quietly is not there.
   */
  inference?: ScenarioInferenceSeams;
}

/**
 * Build the compose factory the handler injects. The returned function is called
 * once per compose:start; it reads settings synchronously (node:sqlite), so any
 * bad scenario.card / llm.config throws HERE (fail loud → the handler's catch
 * emits compose:error before a single delta is streamed).
 */
export function createComposeFactory(
  deps: ComposeFactoryDeps,
): (args: ComposeStartArgs) => ComposeOrchestrator {
  const streamerFor = deps.streamerFor ?? defaultStreamerFor;
  const budgetMs = deps.budgetMs ?? COMPOSE_BUDGET_MS;
  // ONE store per server process — createComposeFactory is called once from
  // bootstrap, and the per-process descriptor cache is the whole reason V2-08 is
  // Option C rather than Option B. A store per compose:start would re-ask the model
  // for every sentence, which is the design that was rejected.
  const inference = new ScenarioInferenceStore({
    settings: deps.settings,
    streamerFor,
    // *** billing call site (LLM metering) — the THIRD recordLlmUsage site ***
    // M6: the scenario-inference round trip spends real tokens on the resolved
    // LLM config (the platform's key under the managed default), and until 0.3.0
    // it was the one LLM call with no meter at all. Same single llm bucket as
    // compose + polish — owner ruling ⑨ (2026-08-04): usage is NOT split per
    // engine, no per-engine dimension is added. BYOK is waived inside the
    // tracker, keyed off the SAME provenance judgement the compose turn uses.
    recordUsage: (userId, tokensIn, tokensOut, isByok): void => {
      deps.usage.recordLlmUsage(userId, { is_byok: isByok }, tokensIn, tokensOut);
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.inference ?? {}),
  });
  return (args: ComposeStartArgs): ComposeOrchestrator => {
    // M4: provenance-carrying resolution (T7). `selected` answers "who gave it" —
    // the BYOK judgement below must never degrade to key shape.
    const selected = resolveLlmConfigWithSource(deps.settings, args.userId);
    const cfg = selected.cfg;
    const byok = resolveByokLlm(selected);
    // §4.1 source ②. The store answers from override > builtin > cached
    // inference synchronously; on a miss it schedules ONE off-band LLM call
    // (behind the consent gate) and returns undefined, so this turn contributes
    // no app-scenario line rather than waiting for a model.
    const appScenario = inference.resolve({
      userId: args.userId,
      cfg,
      byok,
      ...(args.processName !== undefined ? { processName: args.processName } : {}),
    });
    const ctx = resolveScenarioContext(deps.settings, args.userId, appScenario);
    const scenarioBlock = buildScenarioBlock(ctx);
    const system = renderSystemPrompt(
      {
        task: args.task,
        ...(args.sourceLang !== undefined ? { source_lang: args.sourceLang } : {}),
        ...(args.targetLang !== undefined ? { target_lang: args.targetLang } : {}),
      },
      scenarioBlock,
    );
    // §4.1 source ③ deterministic-replacement leg: build the alias→canonical
    // replacer from the SAME terminology sources the scenario block references,
    // and apply it to the correction INPUT (the user message) in run() BEFORE the
    // LLM sees it — the pipeline's `dictionary replacement` step, sitting ahead of the scenario
    // correction. The raw source_text ROW (as spoken) is never rewritten by this
    // (the server compose reads source_text, it does not persist it).
    const replacer = buildDictionaryReplacer(resolveReplacementRules(deps.settings, args.userId));
    return createComposeRun(cfg, system, byok, {
      streamerFor,
      budgetMs,
      replace: (text) => replacer.apply(text),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  };
}

export { type ComposeRun, type ComposeUsage, readComposeUsage, readComposeOutput, createComposeRun } from './orchestrator';
// W2-2 output guard. The guard function is exported for the resident evaluation
// (`verify/eval/run-eval.mjs --mode=guard` bundles THIS source, never a copy);
// the error class is exported because the compose handler catches it by type.
export {
  guardComposeOutput,
  describeGuardRejection,
  ComposeOutputRejectedError,
  COMPOSE_OUTPUT_REJECTED_CODE,
  type ComposeGuardInput,
  type ComposeGuardVerdict,
  type ComposeGuardRule,
  type ComposeGuardRepair,
  type ComposeGuardTask,
} from './output-guard';
export { resolveScenarioContext, resolveReplacementRules } from './scenario-context';
export { buildDictionaryReplacer, type DictionaryReplacer, type TermRule } from './dictionary-replace';
export { buildScenarioBlock, SCENARIO_DELIMITERS, type ScenarioContext } from './scenario';
export { renderSystemPrompt, renderTaskTemplate, promptLanguageName } from './prompt';
// M4: the provenance-carrying resolver + judgement are the billing surface;
// isByokLlm stays exported for the DIAG probe only (see its 🔴 warning).
export {
  resolveLlmConfigWithSource,
  resolveByokLlm,
  managedLlmConfig,
  isByokLlm,
  type SelectedLlmConfig,
  type LlmConfigSource,
} from './llm-config';
export { appCategoryFor, appCategoryDescriptor, type AppCategory } from './app-category';
// V2-08 surface. Deliberately NARROW: the store (the thing bootstrap-adjacent
// code and tests construct), its two dep shapes, and ResolvedDescriptor — which
// is now part of resolveScenarioContext's signature and therefore public whether
// this line exists or not. The rest of scenario-inference / scenario-infer-call
// stays module-internal and is imported by path where it is genuinely needed:
// re-exporting names nothing consumes is how a barrel file turns into a façade.
export {
  ScenarioInferenceStore,
  type ScenarioInferenceDeps,
  type ScenarioInferenceSeams,
} from './scenario-infer-store';
export { type ResolvedDescriptor } from './scenario-inference';
export { taskUsesLlm, SCENARIO_CORRECTION_BUDGET_MS, COMPOSE_BUDGET_MS, type ComposeMode, type ComposeTask } from './mode';
export { streamerFor, streamOpenAiCompatible, streamAnthropic, type LlmEvent, type LlmStreamOpts, type LlmStreamer } from './llm';
