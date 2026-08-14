// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (three tasks, single model; realtime
//     is NOT a compose task — it injects the STT final verbatim, never the LLM),
//     §5 (final pipeline order: dictionary → normalizer → scenario correction →
//     fan-out)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4 (three modes locked,
//     mode switch clears the buffer)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-4 (realtime passthrough / translate / organize)
//
// The three-mode contract for the COMPOSE path.
//
// 🔴 W1.5 CORRECTION — this header used to say the「realtime never touches the
// LLM」red line was "enforced by types, not comments", and that the LLM was
// "structurally unreachable from this mode". BOTH ARE FALSE, and they were false
// about the SYSTEM while being true about THIS FILE — which is why nobody
// noticed. Realtime reaches the vendor through a different door entirely:
//   apps/server-core/src/engine/stt-factory.ts  resolvePolishDep()
// resolves the LLM config for the opt-in AI-polish pass without consulting
// `mode` at all, so a realtime utterance's closing transcript is sent whenever
// the user has turned `stt.polish` on. The user-facing disclosure was wrong for
// a year because of it (ledger C-2).
//
// ⚠️ `modeUsesLlm()` below has ZERO PRODUCTION CALL SITES — grep it: one barrel
// re-export and three test assertions. A constant that tests agree with is not a
// gate. Do not cite this file as evidence that realtime is LLM-free; the only
// honest statement is the narrow one:
//   - `realtime`  → no compose:start exists for it (the protocol task enum has
//                    no such value), so it never runs a COMPOSE turn. That is a
//                    statement about compose, NOT about the LLM.
//   - `translate` → LLM compose (scenario-injected).
//   - `organize`  → LLM compose (scenario-injected).
//
// The compose:start EVENT carries a ComposeTask (translate/organize/draft_polish);
// draft_polish is the DraftPage AI task (mode ④), also LLM-backed. `ComposeMode`
// is the audio-session mode; the two overlap on translate/organize and are kept
// as distinct types so neither leaks the other's members.

export type ComposeMode = 'realtime' | 'translate' | 'organize';
export type ComposeTask = 'translate' | 'organize' | 'draft_polish';

/** True iff the mode routes text through the LLM. `realtime` is the sole
 *  passthrough — the guarantee behind "realtime never touches the LLM". */
export function modeUsesLlm(mode: ComposeMode): boolean {
  return mode !== 'realtime';
}

/** Every compose TASK is LLM-backed (translate/organize/draft_polish). Kept as
 *  a total function so the exhaustiveness guard fires if the union ever grows. */
export function taskUsesLlm(task: ComposeTask): boolean {
  switch (task) {
    case 'translate':
    case 'organize':
    case 'draft_polish':
      return true;
    default: {
      const _exhaustive: never = task;
      throw new Error(`compose/mode: unknown task ${String(_exhaustive)}`);
    }
  }
}

// The scenario-aware correction budget (master-plan §4.1 / 06 §5: the realtime
// polish pass must land within ≤800 ms). Exposed as the correction-path budget;
// translate/organize get the larger COMPOSE_BUDGET_MS below because transforming
// a whole paragraph legitimately runs longer than an in-place correction.
export const SCENARIO_CORRECTION_BUDGET_MS = 800;
// Hard ceiling for a translate/organize/draft_polish turn: fail loud with
// LLM_TIMEOUT rather than hang a socket forever (no silent stall).
export const COMPOSE_BUDGET_MS = 30_000;
