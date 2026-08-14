// SPEC-REF:
//   owner 2026-07-27: "everything deleted…must have a second confirmation"
//   owner 2026-08-12 requirement ① (REQ-12-01): "the phone's and PC's sign-out
//     second-confirmation style needs improvement"
//     —— mechanism kept, what changes is interaction and visuals.
//
// The cloud sign-out second confirm on the device page, pure and DOM-free —
// the same treatment, for the same reason, as its sibling `release-mobile.ts`
// (the unpair (撤销) confirm on the very same page): `<script setup>` cannot export, so a
// rule that exists only as markup is one refactor away from being gone.
//
// 🔴 WHY THIS FILE EXISTS AT ALL — the defect REQ-12-01 found:
// the confirm used to be `const confirmingClearKey = ref(false)` toggled inline
// in DevicesPage.vue's template, and App.vue toggles pages with `v-show`, so
// that component NEVER unmounts. Arming the confirm and then backing out any way
// other than the one small "cancel" button — collapsing the account fold, switching
// to the timeline, signing out and pasting a different key — left it armed for the rest
// of the session. The next time the block rendered, the red "confirm sign-out" was the
// FIRST thing in the card: one click from deleting the Cloud Key, answering a
// question that had been asked minutes earlier at a moment the user had left.
// A second confirm that can cost one click is not a second confirm.
//
// ⇒ the gate is a state machine with ONE arming verb, ONE disarming verb that
// every back-out path calls, and a fire that REFUSES unless armed. The wiring
// (which clicks, which watchers, the expiry timer) stays in the component;
// cloud-signout-confirm.test.ts drives this half and anchors that half.
//
// ⚠️ Deliberately NOT merged with `release-mobile.ts`: that machine is keyed by
// `pairing_id` because it guards N rows and has to prove the user confirmed THIS
// row. There is exactly one Cloud Key on a machine. Reusing it would mean
// passing a fake id, i.e. one value answering two questions — the repo's
// number-one bug shape — to save a file.

/** Armed = the user has been asked and has not answered yet. */
export interface SignOutConfirm {
  armed: boolean;
}

export function newSignOutConfirm(): SignOutConfirm {
  return { armed: false };
}

export function armSignOut(s: SignOutConfirm): void {
  s.armed = true;
}

/** Every way of backing out routes here (cancel (取消) / the fold toggle / a change of
 *  sign-in state / the expiry). Idempotent on purpose — those callers do not
 *  coordinate with each other, and they must not have to. */
export function disarmSignOut(s: SignOutConfirm): void {
  s.armed = false;
}

/** Run the destructive action, or REFUSE.
 *
 *  Returns `null` when it refused — deliberately not `false`, which a caller
 *  could read as 「the sign-out ran and failed」. Disarms BEFORE calling, so a
 *  double-fire (double-click, a re-entrant handler) cannot delete the key twice.
 */
export async function runSignOut<T>(
  s: SignOutConfirm,
  clear: () => Promise<T>,
): Promise<T | null> {
  if (!s.armed) return null;
  s.armed = false;
  return await clear();
}

/** How long an unanswered confirm stays armed.
 *
 *  A confirm is a question, and a question the user walked away from 30 s ago is
 *  not one they are answering. This is what covers the back-out paths the
 *  component cannot observe at all — above all the page switch, which under
 *  `v-show` produces no event on this page whatsoever. Expiry is never
 *  destructive: the card simply goes back to the "sign out of cloud" button. */
export const SIGN_OUT_CONFIRM_TTL_MS = 30_000;
