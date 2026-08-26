// Card PAIR-SUCCESS (owner 2026-08-25, §3-4) — WHEN the PC may say 「the phone
// you are holding up to this QR just paired」.
//
// SPEC-REF:
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §3-4 (design:
//     identity diff, not a count; null device_uid ⇒ count fallback, criterion
//     recorded; success shown ~1 s before the modal closes; the new row flashes)
//   lib/paired-mobiles.ts `PairedMobile.device_uid` (v0.2.4 machine identity)
//
// ── IDENTITY, NOT COUNT ──────────────────────────────────────────────────────
// The tempting criterion — 「the phone count went up」 — answers a different
// question. A phone that is ALREADY paired gains a row when it pairs on the
// other channel (same device_uid, second pairing_id), and any count-based
// detector closes the QR while the user is still holding a NEW phone up to it.
// One value answering two questions is this repo's headline bug shape, so the
// criterion is a DIFF OF IDENTITIES: snapshot the device_uid set when the QR
// opens; success is a uid appearing that was not in it. The owner confirmed
// this deliberately covers scanning, typing the pairing code and manual entry
// alike — the criterion does not care how the device got there.
//
// ── THE FALLBACK, AND WHY IT IS NAMED ───────────────────────────────────────
// `device_uid` is null for a pairing made by a pre-0.2.4 phone. Two nulls are
// not a match, so the uid diff is only trusted when NO null is involved on
// either side; otherwise the row count is used and the criterion that decided
// is returned, so the caller can write it to the forensic log — the next time
// the modal closes on the wrong phone, the log says which ruler was in hand.

import type { PairedMobile } from './paired-mobiles';

export interface PairingSnapshot {
  /** `${channel}:${pairing_id}` of every row — PairedList's row key. */
  keys: ReadonlySet<string>;
  /** Every row's device_uid, or null when ANY row has none (the diff is then
   *  not trustworthy and the count decides). */
  uids: ReadonlySet<string> | null;
  count: number;
}

export type PairingSuccessVerdict =
  | { matched: false }
  | {
      matched: true;
      /** Which ruler decided — written to the forensic log by the caller. */
      criterion: 'uid' | 'count' | 'presence-event';
      /** Row keys that were not in the armed snapshot — the rows to flash. */
      newKeys: string[];
    };

export function rowKeyOf(row: Pick<PairedMobile, 'channel' | 'pairing_id'>): string {
  return `${row.channel}:${row.pairing_id}`;
}

/** Freeze what the paired list looked like when the QR opened.
 *
 *  🔴 CORRECTED 2026-08-25 (acceptance, measured). This doc used to end 「so a
 *  later successful read cannot be mistaken for a pairing」 and that was FALSE
 *  in the direction that mattered: `null` / `undefined` rows snapshot as EMPTY
 *  **with uids null**, and a null uid forces the COUNT ruler below — so against
 *  that baseline the next successful read answers `matched: true` for phones
 *  that were paired all along.
 *
 *  The function's own answer is right: asked 「did this list grow」 against an
 *  empty baseline, it did. What was wrong was the SENTENCE, which promised a
 *  guarantee this layer cannot give. The policy 「an unreadable list may not be
 *  a baseline」 lives in `use-pairing-success.ts`, where the arming happens.
 *
 *  ⇒ anti-façade ④, again: a comment describing behaviour that lives somewhere
 *  else. Nothing about the code below changed. */
export function snapshotPairing(rows: readonly PairedMobile[] | null | undefined): PairingSnapshot {
  if (!rows) return { keys: new Set(), uids: null, count: 0 };
  const keys = new Set<string>();
  const uids = new Set<string>();
  let anyNull = false;
  for (const r of rows) {
    keys.add(rowKeyOf(r));
    if (r.device_uid === null) anyNull = true;
    else uids.add(r.device_uid);
  }
  return { keys, uids: anyNull ? null : uids, count: rows.length };
}

/** Did a NEW device appear between `armed` (the QR opened) and `now`? */
/** Did a pairing just succeed between `armed` (the QR opened) and `now`?
 *
 * 🔴 `joined` (2026-08-26, owner) — 「a phone entered the room while the QR was
 * on screen」, and it is the rule that finally makes RE-pairing work.
 *
 * The two rulers below both ask 「did this LIST change」, and re-pairing a
 * handset that is already in it changes nothing: same device_uid, same count.
 * Measured on owner's machine 2026-08-26 — the epoch fix had the paired list
 * re-reading correctly by then, and the modal STILL never closed, because there
 * was nothing new to find. owner's ruling is that the confirmation fires on
 * every new pairing INCLUDING a re-pair.
 *
 * A modal is a person standing in front of the screen holding a phone at it. A
 * phone joining during that window IS the pairing they just did — no diff
 * required. The identity rulers are kept because they still answer a second
 * question this one cannot: WHICH row to flash.
 */
export function detectPairingSuccess(
  armed: PairingSnapshot,
  rows: readonly PairedMobile[] | null | undefined,
  joined = false,
): PairingSuccessVerdict {
  if (!rows) return { matched: false };
  const now = snapshotPairing(rows);
  const newKeys = rows.filter((r) => !armed.keys.has(rowKeyOf(r))).map(rowKeyOf);
  if (armed.uids !== null && now.uids !== null) {
    // The trustworthy ruler: a device identity we had never seen.
    //
    // 🔴 Finding nothing FALLS THROUGH now (2026-08-26 review). The first cut
    // early-returned `matched: false` here — which made the `joined` ruler
    // below unreachable in exactly the case it was added for: a RE-pair has
    // readable uids on both sides and nothing fresh, so the headline case of
    // that change never fired. Zero tests covered it, so nothing said so.
    const fresh = [...now.uids].filter((u) => !armed.uids!.has(u));
    if (fresh.length > 0) {
      const freshSet = new Set(fresh);
      return {
        matched: true,
        criterion: 'uid',
        newKeys: rows.filter((r) => r.device_uid !== null && freshSet.has(r.device_uid)).map(rowKeyOf),
      };
    }
  } else if (now.count > armed.count) {
    // A null uid is in play on one side or the other: fall back to the count and
    // SAY so. (Same-device second-channel rows are indistinguishable here — that
    // is the known cost of pre-0.2.4 phones, recorded rather than hidden.)
    return { matched: true, criterion: 'count', newKeys };
  }
  // Neither list ruler found anything — which for a RE-pair is the correct
  // answer to the question they were asked. The event answers the question the
  // user actually asked by holding a phone up to the QR.
  if (joined) {
    // Nothing new by identity, so flash the row that is actually in the room —
    // and only when there is exactly one, because naming one of several would
    // be a guess. No key just means no flash; the modal still closes.
    const online = rows.filter((r) => r.online).map(rowKeyOf);
    return { matched: true, criterion: 'presence-event', newKeys: online.length === 1 ? online : [] };
  }
  return { matched: false };
}
