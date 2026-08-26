// Card LLM-NOTICE (owner 2026-08-25, D2) — the dismissible first-run card that
// says 「this PC has no language model yet」 and JUMPS to the two configurations.
//
// SPEC-REF:
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §0 D2 / §2-②
//   main-window/settings-model.ts `llmCapabilityUsable` (card POLISH-CFG) — the
//     ONE fact this card reads; never inferred from an empty `llm.config` row.
//   main-window/components/LocalModelNotice.vue — the sibling strip whose slot
//     and posture (above the pages, not modal, one dismissal) this card shares.
//
// Pure decision + the one persisted key, kept out of the SFC so the rule is
// unit-testable without a renderer and so the SFC cannot grow a second answer
// to 「show it or not」.
//
// 🔴 「first run」 means 「until the reader puts it away」, not 「the first
// launch」: the fact it states does not go away on its own, and a card that
// vanished after one launch would leave a user who never opened settings with
// nothing. The dismissal is REMEMBERED (localStorage), unlike LocalModelNotice's
// per-session one, because owner asked for a first-run card, i.e. one that
// stays gone once acknowledged.
//
// 🔴 The 「read the guide」 link is deliberately ABSENT: the web section it
// would point at does not exist yet (execution plan §3-3 chose `/guide#model`,
// still unbuilt), and a link that opens nothing is the dead-link defect 0.3.24
// fixed. Add it only after the page is live, through `openExternalUrl`.

/** The remembered dismissal. `'1'` = put away. Never travels the wire. */
export const K_LLM_SETUP_CARD_DISMISSED = 'flowmic.ui.llm.setupCard.dismissed';

/** Minimal storage seam (lib/storage's localKv fits; tests pass a Map-backed one). */
export interface DismissalKv {
  get(key: string): string | null;
  set(key: string, value: string): unknown;
}

export function readSetupCardDismissed(kv: DismissalKv): boolean {
  try {
    return kv.get(K_LLM_SETUP_CARD_DISMISSED) === '1';
  } catch {
    return false;
  }
}

export function writeSetupCardDismissed(kv: DismissalKv): void {
  kv.set(K_LLM_SETUP_CARD_DISMISSED, '1');
}

/** Show the card iff the SERVER has said the model is not usable AND the reader
 *  has not put it away. `usable === true` (the pre-first-sync value, deliberately:
 *  「we have not been told anything, so we assert nothing」) hides it, so a
 *  configured PC never flashes the card on a cold start. */
export function shouldShowLlmSetupCard(input: { usable: boolean; dismissed: boolean }): boolean {
  return !input.usable && !input.dismissed;
}
