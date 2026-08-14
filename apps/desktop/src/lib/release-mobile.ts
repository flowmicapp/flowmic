// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:release-mobile { mobile_id?, revoke? })
//   docs/rebuild/05-DATA-MODEL.md §7 (deleting the row IS the revocation)
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-08
//   *** HUMAN-AUDIT ADJACENT (pairing/auth) ***
//
// The device page's 「断开｜撤销」("disconnect | revoke") action core, pure and DOM-free so the three
// rules that MUST hold can be pinned by tests instead of by template discipline
// (`<script setup>` cannot export, and a rule that only exists as markup is one
// refactor away from being gone):
//
//   ① REVOKE IS GATED ON A SECOND CONFIRMATION — `performRelease(..., revoke:true)`
//      refuses unless THIS row is the one the user confirmed. The guard lives in
//      the state machine, so a stray click path cannot reach a permanent
//      revocation without passing through it.
//   ② A FAILED ACTION NEVER REFRESHES THE TABLE — re-rendering the same list
//      after a refused/timed-out call is indistinguishable from success. The row
//      goes loud instead, and the confirmation STAYS open so the user can retry
//      the exact act they intended.
//   ③ ONE ACTION AT A TIME — a second click (any row) while one is in flight is
//      dropped, so two overlapping calls cannot interleave their refreshes.

import type { ChannelId } from './paired-mobiles';

export interface ReleaseActionState {
  /** pairing_id awaiting the revoke second confirmation, or null. */
  confirmId: string | null;
  /** pairing_id whose action is in flight (blocks every row — rule ③). */
  busyId: string | null;
  /** pairing_id whose last action FAILED, rendered loudly on that row. */
  failedId: string | null;
}

export interface ReleaseDeps {
  /** The bridge call → `pc:release-mobile`. Resolves whether the action really
   *  happened (for a revoke: whether a row was actually removed).
   *
   *  v0.2.7 — `channel` names the server that OWNS the row. Without it the call
   *  went to whichever channel was primary, and a local-LAN row revoked while
   *  cloud was primary was answered by the relay with 「ok, revoked 0」. */
  release(id: string, revoke: boolean, channel?: ChannelId): Promise<boolean>;
  /** Re-read the paired table. Called ONLY after a real success (rule ②). */
  reload(): Promise<void>;
}

export function newReleaseState(): ReleaseActionState {
  return { confirmId: null, busyId: null, failedId: null };
}

/** Open the revoke confirmation for one row (and clear a stale failure notice). */
export function askRevoke(state: ReleaseActionState, id: string): void {
  state.failedId = null;
  state.confirmId = id;
}

export function cancelRevoke(state: ReleaseActionState): void {
  state.confirmId = null;
}

/** Run disconnect (`revoke:false`) or revoke (`revoke:true`). Returns whether the server
 *  confirmed it. A revoke that has not been confirmed for THIS row is refused
 *  locally: nothing is sent, and that is deliberately NOT reported as a failure —
 *  it is a UI precondition, not a server verdict. */
export async function performRelease(
  state: ReleaseActionState,
  deps: ReleaseDeps,
  id: string,
  revoke: boolean,
  channel?: ChannelId,
): Promise<boolean> {
  if (state.busyId !== null) return false; // ③
  if (revoke && state.confirmId !== id) return false; // ①
  state.busyId = id;
  state.failedId = null;
  try {
    const ok = await deps.release(id, revoke, channel);
    if (!ok) {
      state.failedId = id; // ② loud, and the confirmation stays open
      return false;
    }
    state.confirmId = null;
    await deps.reload();
    return true;
  } finally {
    state.busyId = null;
  }
}
