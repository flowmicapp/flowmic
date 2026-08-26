// Card PAIR-SUCCESS (owner 2026-08-25, §3-4) — the device page's reaction to
// a NEW phone pairing while the QR modal is open: show a success face for
// about a second, close the modal, then flash the new row twice.
//
// SPEC-REF:
//   lib/pairing-success.ts — the criterion (identity diff; count fallback,
//     criterion recorded). This file owns only TIME and the forensic line.
//   components/PairingModal.vue `success` prop / components/PairedList.vue
//     `flashKey` prop — the two renderers.
//   DevicesPage.vue — the one caller (`arm` when the modal opens, `observe` on
//     every paired-list read; the existing perChannelMobiles watch already
//     triggers that read on any channel's phone count changing — confirmed,
//     not rewritten: that watch fixed a structural defect and its post-mortem
//     comment is still in place).
//
// ── WHY A SUCCESS FACE BEFORE CLOSING ──────────────────────────────────────
// A dialog that vanishes unexplained reads as a crash. ~1 s of 「connected ✓」
// is the difference between 「it worked」 and 「what just happened」.
//
// ── WHY THE FLASH ENDS BY ITSELF, ON A TIMER ────────────────────────────────
// It is EVENT-type (something happened once), so it must end without the user
// doing anything. The CSS animation runs two iterations; the class is ALSO
// removed by this timer, so a headless test can assert the ending instead of
// eyeballing it, and `prefers-reduced-motion` (animation: none in the CSS)
// still leaves the row un-flagged afterwards. It never steals focus: it is a
// class on a list item, nothing else.
//
// No ruling blocks auto-closing: the 「never auto-closes on the user」 comment
// in PairingModal.vue is about the address disclosure block, not the modal.

import { ref, type Ref } from 'vue';
import type { PairedMobile } from '../lib/paired-mobiles';
import { detectPairingSuccess, snapshotPairing, type PairingSnapshot } from '../lib/pairing-success';

/** How long the modal shows 「connected」 before it closes. */
export const PAIR_SUCCESS_HOLD_MS = 1000;
/** Two iterations of the 0.7 s CSS flash, plus a little slack — the timer is
 *  the authority, the animation just paints it. */
export const PAIR_FLASH_MS = 1600;

export interface PairingSuccessDeps {
  /** Close the modal — DevicesPage's `closeModal`. */
  close(): void;
  /** Forensic line writer — `appendForensic('devices', …)`. */
  forensic(msg: string): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export interface PairingSuccess {
  /** The modal's success face is up. */
  success: Ref<boolean>;
  /** The `${channel}:${pairing_id}` of the row currently flashing, or null. */
  flashKey: Ref<string | null>;
  /** Call when the QR modal opens: freezes the identity snapshot. */
  arm(rows: readonly PairedMobile[] | null | undefined, epoch?: number): void;
  /** Call on every paired-list read while armed. `epoch` is the shell's JOIN
   *  counter (socket/reconcile.rs `join_epoch`, summed over channels) — an
   *  INCREASE since arming means a phone entered the room while the QR was on
   *  screen, which is the only ruler that can see a RE-pair (owner 2026-08-26).
   *  🔴 Never feed it `presence_epoch`: that one also counts departures, and a
   *  phone LEAVING must not close the QR with a success face. */
  observe(rows: readonly PairedMobile[] | null | undefined, epoch?: number): void;
  /** Call when the modal closes for any other reason (✕): disarms. */
  disarm(): void;
  dispose(): void;
}

export function usePairingSuccess(deps: PairingSuccessDeps): PairingSuccess {
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const success = ref(false);
  const flashKey = ref<string | null>(null);
  let armed: PairingSnapshot | null = null;
  let holdTimer: unknown = null;
  let flashTimer: unknown = null;

  /** 🔴 The QR opened before the paired list could be read.
   *
   *  MEASURED during acceptance (2026-08-25): arming on a `null` / `undefined`
   *  list froze a snapshot of `{keys: ∅, uids: null, count: 0}`, and because a
   *  null uid forces the COUNT ruler, the very next successful read reported
   *  `matched: true, criterion: 'count'` — for a phone that had been paired all
   *  along. The QR would close, and a row would flash, while the user was still
   *  holding their phone up to it. That is the exact false positive the identity
   *  ruler exists to prevent, arriving through the fallback door.
   *
   *  Both states reach `arm` in production, and neither is exotic:
   *  `pairedView` is `undefined` while the first read is in flight and `null`
   *  when a read FAILED (DevicesPage assigns that verbatim, on purpose).
   *
   *  ⇒ An unreadable list does not arm anything. The first list we can actually
   *  see becomes the baseline, and that same read is never judged against it. */
  let awaitingBaseline = false;
  /** The join counter as the QR opened; null when we never saw one. */
  let armedEpoch: number | null = null;

  function arm(rows: readonly PairedMobile[] | null | undefined, epoch?: number): void {
    success.value = false;
    armedEpoch = epoch ?? null;
    if (!rows) {
      armed = null;
      awaitingBaseline = true;
      return;
    }
    armed = snapshotPairing(rows);
    awaitingBaseline = false;
  }

  function disarm(): void {
    armed = null;
    awaitingBaseline = false;
  }

  function observe(rows: readonly PairedMobile[] | null | undefined, epoch?: number): void {
    if (success.value) return;
    if (awaitingBaseline) {
      if (!rows) return; // still nothing to compare against
      armed = snapshotPairing(rows);
      awaitingBaseline = false;
      return; // the read that BECAME the baseline is not judged against it
    }
    if (armed === null) return;
    // `>` and never `!==`: the sum can DECREASE without any phone doing anything
    // (a channel's row leaving the map, a shell restart resetting its counter),
    // and the safe failure direction is a modal that stays open — the user
    // closes it by hand, the old behaviour — not one that closes claiming a
    // pairing that never happened. The known residual: a decrease can mask the
    // next real join for one arming; recorded, not hidden.
    const joined = armedEpoch !== null && epoch !== undefined && epoch > armedEpoch;
    const verdict = detectPairingSuccess(armed, rows, joined);
    if (!verdict.matched) return;
    // One detection per arming: the snapshot is consumed so a second read of
    // the same list cannot re-fire while the face is up.
    armed = null;
    deps.forensic(
      `pairing success: criterion=${verdict.criterion} new=${verdict.newKeys.join(',') || '(none)'} — closing the QR modal in ${PAIR_SUCCESS_HOLD_MS}ms`,
    );
    success.value = true;
    const first = verdict.newKeys[0] ?? null;
    if (holdTimer !== null) clearT(holdTimer);
    holdTimer = setT(() => {
      holdTimer = null;
      success.value = false;
      deps.close();
      if (first !== null) {
        flashKey.value = first;
        if (flashTimer !== null) clearT(flashTimer);
        flashTimer = setT(() => {
          flashTimer = null;
          flashKey.value = null; // ends by itself — asserted, not eyeballed
        }, PAIR_FLASH_MS);
      }
    }, PAIR_SUCCESS_HOLD_MS);
  }

  function dispose(): void {
    if (holdTimer !== null) clearT(holdTimer);
    if (flashTimer !== null) clearT(flashTimer);
    holdTimer = flashTimer = null;
    armed = null;
    awaitingBaseline = false;
  }

  return { success, flashKey, arm, observe, disarm, dispose };
}
