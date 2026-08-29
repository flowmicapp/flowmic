// Card STT-SETUP (owner ruling 2026-08-28, item 1) — 「this machine has no
// speech model for the language you are likely to speak」, with one button that
// starts the recommended download and takes the reader to where it is visible.
//
// SPEC-REF:
//   docs/decisions/2026-08-28-owner-first-run-stt-and-llm-onboarding.md
//   ./llm-setup-card.ts — the sibling this file mirrors in shape (same
//     DismissalKv seam, same remembered-dismissal posture, same 「pure decision
//     out of the SFC」 reason). The two cards sit side by side in App.vue.
//   ./model-status.ts `readyPackForLang` — the ONE fact this card reads.
//
// ── 🔴 「不知道」 AND 「没有」 GET DIFFERENT ANSWERS, AND ONLY ONE HAS A BUTTON ──
//
// `readyPackForLang` returns `null` for BOTH 「the status is unknown」 and
// 「no pack is ready」 — its own header says so and tells the caller to render
// nothing for the first. That merge is the whole trap of this predicate, so the
// status-null arm is checked FIRST and returns false before the probe is ever
// consulted. Getting it the other way round would offer a ~200 MB download on
// the strength of a local service that has not answered yet — i.e. on every
// cold start, during the seconds before the sidecar is up.
//
// ── 🔴 THE GATE IS THE PROBED STATE, NEVER A 「点过了」 FLAG ────────────────────
//
// Owner, verbatim: 「已配置者不显示（探测真实状态，不许靠「点过了」标记冒充「配好
// 了」）」. So there is exactly one persisted bit here and it means 「the reader
// put this card away」 — never 「a model exists」. A machine whose download
// failed halfway must see the card again on the next launch, and it does,
// because the download button writes nothing into this key.

import { ref } from 'vue';
import type { DismissalKv } from './llm-setup-card';
import { machineSpokenLang } from './machine-spoken-lang';
import { modelStore } from './model-client';
import {
  readyPackForLang,
  recommendedPackForLang,
  type CatalogEntry,
  type ModelsStatus,
} from './model-status';
import { localKv } from './storage';

/** The remembered dismissal. `'1'` = put away. Never travels the wire. */
export const K_STT_SETUP_CARD_DISMISSED = 'flowmic.ui.stt.setupCard.dismissed';

export function readSttSetupCardDismissed(kv: DismissalKv): boolean {
  try {
    return kv.get(K_STT_SETUP_CARD_DISMISSED) === '1';
  } catch {
    return false;
  }
}

export function writeSttSetupCardDismissed(kv: DismissalKv): void {
  kv.set(K_STT_SETUP_CARD_DISMISSED, '1');
}

/**
 * Show the card iff we HAVE a status, that status has no ready pack for the
 * language, and the reader has not put it away.
 *
 * Pure and kv-free so the rule is unit-testable with no renderer and no
 * storage, and so the SFC cannot grow a second answer to 「show it or not」 —
 * the same reason `shouldShowLlmSetupCard` next door is a function.
 */
export function shouldShowSttSetupCard(input: {
  status: ModelsStatus | null;
  language: string;
  dismissed: boolean;
}): boolean {
  if (input.status === null) return false;
  if (input.dismissed) return false;
  // A download is already running SOMEWHERE on this machine (downloads are
  // single-flight, server-side). The card's only action would be refused with a
  // 409, and its progress already has exactly one owner on screen — the model
  // card. Offering a second door to a thing in motion is the noise this card is
  // supposed to reduce.
  if (input.status.busy_model_id !== null) return false;
  // No offerable pack ⇒ no card: see [recommendedPackForLang]. Checked here
  // rather than in the SFC so 「show it or not」 keeps one answer.
  if (recommendedPackForLang(input.status, input.language) === null) return false;
  return readyPackForLang(input.status, input.language) === null;
}

/** The dismissal, as reactive state SHARED by the card and by App.vue.
 *
 *  🔴 IT HAS TO BE SHARED, AND THAT IS THE WHOLE REASON THIS IS NOT A `ref`
 *  INSIDE THE SFC (which is what the LLM card does). App.vue suppresses
 *  LocalModelNotice while this card is up, so it evaluates the same predicate —
 *  and a second copy of the dismissal would mean that pressing 「稍后再说」 hid
 *  this card while the amber strip stayed suppressed, i.e. one value answering
 *  two questions in the two places that must agree.
 *
 *  Hydrated eagerly at module load: `localKv` swallows a missing localStorage
 *  (Node, SSR) and answers `null`, so this costs one guarded read and removes
 *  any 「has it been hydrated yet」 state. Tests drive it through
 *  [hydrateSttSetupCardDismissal] with their own seam. */
const dismissed = ref(readSttSetupCardDismissed(localKv));

export function sttSetupCardDismissed(): boolean {
  return dismissed.value;
}

/** Read the persisted bit out of `kv` and adopt it. The test seam, and the
 *  reset path: passing an empty kv puts the card back. */
export function hydrateSttSetupCardDismissal(kv: DismissalKv): void {
  dismissed.value = readSttSetupCardDismissed(kv);
}

/** Put the card away for good — persists AND updates the shared state, in that
 *  order, so a storage refusal cannot leave the two disagreeing about a bit
 *  that outlives the session. */
export function dismissSttSetupCard(kv: DismissalKv = localKv): void {
  writeSttSetupCardDismissed(kv);
  dismissed.value = true;
}

/** Everything the two readers of this card need, derived from the ONE model
 *  store — the card itself (what to render) and App.vue (whether to suppress
 *  LocalModelNotice while this card is up). Reactive by construction: it only
 *  reads `modelStore` and the dismissal ref, so a caller wrapping it in a
 *  `computed` re-evaluates when the poller lands a new status. */
export function sttSetupCardView(): {
  show: boolean;
  language: string;
  pack: CatalogEntry | null;
} {
  const status = modelStore.status;
  const language = machineSpokenLang(status?.spoken_langs);
  return {
    show: shouldShowSttSetupCard({ status, language, dismissed: dismissed.value }),
    language,
    pack: recommendedPackForLang(status, language),
  };
}
