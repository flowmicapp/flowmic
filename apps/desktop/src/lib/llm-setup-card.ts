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
// 🔴 CORRECTED 2026-08-28 — the 「read the guide」 link is PRESENT. This block
// used to say it was deliberately absent because the web section it would point
// at did not exist (execution plan §3-3 chose `/guide#model`, still unbuilt at
// the time) and a link that opens nothing is the dead-link defect 0.3.24 fixed.
// That reasoning held until the 2026-08-27 web round shipped the chapter: it is
// `/guide/model`, a member of `GUIDE_DOC_IDS`, localized by lowercase prefix.
// The owner asked for the link the next day. It was added the way that block
// required — through `openExternalUrl`, with the address left on screen when the
// open is refused. Address construction lives in ./site-guide.ts.

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
