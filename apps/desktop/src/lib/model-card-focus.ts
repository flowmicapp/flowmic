// One shared handle so the routing table's 「go and download one」 can actually
// land somewhere useful. Owner ruling 2026-08-27 section 2-3.
//
// ── WHY A MODULE AND NOT AN EMIT ────────────────────────────────────────────
//
// The routing table (SttSettings.vue) and the pack list (LocalModelCard.vue)
// are siblings in one section, and the useful action is not 「scroll down」 —
// it is 「show me THAT language's packs」. Passing it as a prop would make the
// card's own picker a controlled input owned by its parent, which is a much
// bigger change than the ruling asks for and would leave two writers for one
// value. A module-scope ref is the smallest thing that keeps ONE writer per
// question: the table asks, the card answers, and the card's picker stays the
// card's.
//
// ── 🔴 IT IS A REQUEST, NOT A SETTING ───────────────────────────────────────
//
// Nothing here is persisted and nothing here is on the wire. It is 「the user
// just pressed a button asking to look at X」, which stops being true the moment
// they touch the picker themselves — so the card WATCHES it and copies it into
// its own state rather than rendering from it. A card that rendered straight
// off this value would refuse to let the user navigate away from the language
// the table sent them to, which is the failure mode of every one-way binding
// mistaken for state.
//
// The DOM half (scrolling the card into view) is deliberately NOT here: it is a
// single `scrollIntoView` at the press site, and hiding it behind an
// abstraction would make it look like a mechanism.

import { ref } from 'vue';

/** The element id the card's root carries, and the anchor the table scrolls to.
 *  Exported so neither side spells it as a literal — a scroll target that
 *  silently misses is indistinguishable from one that works, since
 *  `getElementById` returning null throws nothing and does nothing. */
export const LOCAL_MODEL_CARD_ID = 'flowmic-local-model-card';

/** The last request, or `null` for 「nobody has asked」 — which is the state
 *  every session starts in and the state the card renders its OWN default in.
 *
 *  🔴 IT CARRIES A SEQUENCE NUMBER, AND THAT IS NOT DECORATION. A plain string
 *  ref only notifies on CHANGE, so pressing the same row's button twice would
 *  fire once: the second press would do nothing visible, and 「the button is
 *  broken」 is exactly what a user concludes when a press has no effect. A fresh
 *  object per call makes every press a distinct event. (Clearing to `null` and
 *  re-setting in the same tick does NOT work — Vue batches, so the watcher sees
 *  only the final value and compares it to the same previous one.) */
export const requestedModelLang = ref<{ lang: string; seq: number } | null>(null);

let seq = 0;

/** Ask the local-model card to show `lang`'s packs, and scroll it into view. */
export function focusLocalModelCard(lang: string): void {
  seq += 1;
  requestedModelLang.value = { lang, seq };
  document.getElementById(LOCAL_MODEL_CARD_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Test seam: forget any pending request. Component tests render the card fresh
 *  and must not inherit a language another case asked for — module state
 *  outlives a component instance, which is the trap every module-scope store in
 *  this repo carries. */
export function resetModelCardFocusForTest(): void {
  requestedModelLang.value = null;
}
