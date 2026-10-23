// SPEC-REF:
//   apps/server-core/src/stt/engine-factory.ts (`withHotwords` / `withSonioxContext`
//     — the two production writers that consult `terminologyDestinationFor`)
//   apps/server-core/src/engine/stt-factory.ts (the `hotwords` pipeline-trace
//     record, built by `terminologyTraceFields`)
//   apps/server-core/src/stt/terminology-context.ts (`SonioxContextAssembly`)
//
// Card CTX-1 — ONE answer to "which engine is told terminology, and how".
//
// Before this file the answer lived in two places that disagreed: the
// decorators in engine-factory.ts sent `{term:weight}` hotwords to FunASR and a
// `context` string to Soniox, while the pipeline trace still said
// `engine_accepts_hotwords: engineId === 'funasr'` and `delivered: false` for
// every Soniox session — so the one diagnostic that exists to tell a reader
// "did the terms reach the recognizer" answered "no" for the production engine.
// Both now read the table below, so they cannot drift apart again.

import type { SonioxContextAssembly } from './terminology-context';

/** How an engine is told the session's terms: FunASR takes a `{term:weight}`
 *  hotwords payload, Soniox a `context` string, every other engine nothing. */
export type TerminologyDestination = 'hotwords' | 'context';

// A Map, not an object literal: an engine id such as 'constructor' or
// 'toString' must answer "no destination", not a prototype member.
const DESTINATION_BY_ENGINE: ReadonlyMap<string, TerminologyDestination> = new Map([
  ['funasr', 'hotwords'],
  ['soniox', 'context'],
]);

export function terminologyDestinationFor(engineId: string | undefined): TerminologyDestination | undefined {
  return engineId === undefined ? undefined : DESTINATION_BY_ENGINE.get(engineId);
}

/** Fields of the `hotwords` pipeline-trace record. Counts only — never terms. */
export function terminologyTraceFields(
  engineId: string | undefined,
  ruleCount: number,
  context: SonioxContextAssembly,
): Record<string, unknown> {
  const dest = terminologyDestinationFor(engineId);
  const delivered = dest === 'hotwords' ? ruleCount > 0
    : dest === 'context' ? context.context !== undefined
      : false;
  return {
    engine: engineId ?? '(no routing matched)',
    destination: dest ?? 'none',
    engine_accepts_hotwords: dest === 'hotwords',
    engine_accepts_context: dest === 'context',
    term_count: ruleCount,
    ...(dest === 'context'
      ? { context_source: context.source, context_user_terms: context.userTerms, context_default_terms: context.defaultTerms, context_dictation_terms: context.dictationTerms, context_chars: context.chars }
      : {}),
    delivered,
  };
}
