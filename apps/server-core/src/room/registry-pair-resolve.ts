// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (mobile:pair address resolution)
//   docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md (0.2.66 PCID)
//
// 🔴 STRUCTURAL SPLIT ONLY (WP-9, 2026-09-02) — registry.ts hit the 800-line
// cap (`verify:lint file-size`) while landing the WP-9 mobile-device-dedup
// fix, the same pressure and the same remedy `bootstrap-http-deps.ts` and
// `stt/quota-recheck.ts` name in their own headers: take a coherent family out
// WHOLE rather than trim the reasoning a comment carries. `Registry.
// resolvePcForPair` / `resolvePcByPcid` moved here VERBATIM — every comment,
// every branch, byte-for-byte — with exactly the seam adaptation a
// class-method-to-free-function move forces: `this.deps` / `this.codes`
// became explicit parameters, and `this.resolvePcByPcid(...)` became
// `resolvePcByPcid(deps, codes, ...)`. Nothing else changed. The class's own
// `resolvePcForPair` method is now a one-line delegator (registry.ts) —
// exactly the shape `quota-recheck.ts` already established for the same kind
// of split (「the WHEN lives in the caller, the RULE lives here」).

import type { ServerMode } from '@flowmic/protocol';
import { ServerError } from '../errors';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import { ShortCodeGovernor, findActivePcByCode } from './short-code';
import { isRealPc, PCID_RE, type PairInput } from './registry-shared';

/** The slice of `Registry`'s own deps this family reads. Narrower than
 *  `RegistryDeps` on purpose — it makes the dependency direction explicit
 *  (this file cannot reach back into anything else `Registry` holds) and
 *  makes a unit test constructible without the rest of the class's wiring. */
export interface PairResolveDeps {
  mode?: ServerMode;
  pcs: PcRepo;
}

/** VERBATIM (see file header) — was `Registry.prototype.resolvePcForPair`. */
export function resolvePcForPair(deps: PairResolveDeps, codes: ShortCodeGovernor, input: PairInput): PcRecord {
  const { pcs } = deps;
  let code: string | undefined;
  let pcid: string | undefined;
  if (input.short_code) {
    if (!/^\d{4}$/.test(input.short_code)) throw new ServerError('PAIR_INVALID_CODE');
    code = input.short_code;
    pcid = input.pcid;
  } else if (input.qr_payload) {
    const m = /code=(\d{4})/.exec(input.qr_payload);
    if (!m) throw new ServerError('PAIR_INVALID_PAYLOAD');
    code = m[1];
    // 0.2.66 — the QR arm's PCID travels INSIDE the payload, appended after
    // `code=` (04 §3.1). Extracting it here rather than in a second parser is
    // what makes owner's "scanning a QR and typing it are the same logic" true in the code and not just
    // in the copy: from the next line on, the two arms are one path.
    // ⚠️ A phone built before 0.2.66 forwards the scanned link VERBATIM
    // (mobile wire_payloads.dart), so this finds the pcid in a new PC's QR
    // even though that phone knows nothing about PCIDs. That is not luck — it
    // is the append-after-`code=` discipline paying out (04 §3.1 rule 4).
    pcid = /pcid=(\d{9})/.exec(input.qr_payload)?.[1];
  } else {
    throw new ServerError('PAIR_INVALID_PAYLOAD');
  }
  // ── 0.2.66 · SAAS: address first, THEN check the secret ───────────────────
  // owner 2026-08-14: "the cloud relay does not support establishing a
  // connection by typing the pairing code directly". Standalone falls
  // through to the historical global-code path below — there is no PCID on the
  // LAN, and this branch must never make the LAN stricter.
  if (deps.mode === 'saas') return resolvePcByPcid(deps, codes, pcid, code as string);
  const rows = pcs.listByShortCode(code as string);
  const pc = findActivePcByCode(rows, (id) => codes.isActive(id));
  if (!pc) {
    // IT-39 — THE per-code brute-force charge, and the only one. Placed after
    // the resolve (so a legitimate pairing is never charged) and after the two
    // malformed-input throws above (so junk cannot burn codes), which makes
    // this line reachable by exactly one thing: a well-formed guess that
    // probed the code space and missed. `recordFailedGuess` decides which
    // issuance pays; see its comment in short-code.ts.
    codes.recordFailedGuess();
    // U3-EXPIRED-VS-INVALID (0.3.0) — the two misses are two different facts
    // and used to collapse into one code (the typo answer for an aged-out
    // code was the launch register's E4):
    //   · rows matched ⇒ this exact string IS some real PC's most recent
    //     issuance — pc_devices.short_code is a single overwritten column,
    //     so a row matches a code only while that code is the newest one —
    //     and the only way it stopped resolving is that its ACTIVE window
    //     lapsed: the TTL ran out (short-code.ts isActive), the governor's
    //     in-memory issuance table was lost to a restart, or — IT-39 — the
    //     issuance spent its failure budget and was BURNED
    //     (short-code.ts isBurned). Either way PAIR_EXPIRED_CODE's "please refresh"
    //     names the action that fixes it.
    //
    // IT-39 — HOW HONEST THIS PAIR OF ANSWERS IS, exactly, since a burn is a
    // third fact riding on a two-value vocabulary and no error code was added:
    //   · "guessed wrong" vs "this code got burned" ARE told apart, by the branch below: a
    //     string that matches nothing is PAIR_INVALID_CODE; the real, burned
    //     string is PAIR_EXPIRED_CODE. Different code, and the ACTION each
    //     names is the right one for its case.
    //   · "burned" vs "expired" are NOT told apart, and deliberately so even
    //     though isBurned could. Splitting them on the wire would tell a
    //     sprayer "your spray worked" — an oracle paid for with a red line
    //     (a new error code is an owner gate) to tell the attacker something
    //     only the attacker wants. The user-facing action is identical
    //     ("refresh") and correct in both. Recorded as a known limit of the
    //     vocabulary, not as an omission: the server-side line
    //     `short_code.burned` (short-code.ts) is where that distinction lives.
    //   · zero rows ⇒ the string matches nothing stored ⇒ PAIR_INVALID_CODE.
    // A SUPERSEDED code (its PC has since minted a newer one — re-register or
    // refreshShortCode) lands in the second bucket BY CONSTRUCTION: every
    // re-mint writes the new code over the same column (pc.repo.ts
    // setShortCode) in the same breath as it stamps the governor, so the old
    // string matches zero rows and is physically indistinguishable from one
    // that never existed. Deciding 「expired」 for it would need a
    // code-history table (a DB migration — an owner gate); we implement the
    // distinguishable subset and document the limit here.
    // The isRealPc filter is load-bearing twice over: the F-3140
    // cloud-instance rows hold the well-known constant '0000' and are never
    // stamped ACTIVE, so without it that constant would answer "expired,
    // please refresh" forever — false (no refresh can ever activate it) and an
    // existence oracle over a code every probe knows. EXPIRED is only
    // emitted when the probed string matches a real PC's stored issuance; a
    // guess that matches nothing keeps reading PAIR_INVALID_CODE, and the
    // brute-force gate (pair-rate-limit) throttles both answers alike.
    if (rows.some(isRealPc)) {
      throw new ServerError('PAIR_EXPIRED_CODE', 'code was issued but its active window lapsed');
    }
    throw new ServerError('PAIR_INVALID_CODE', 'no active PC for code');
  }
  return pc;
}

/** 0.2.66 — the SAAS resolve: the PCID says WHICH PC, the code says WHETHER.
 *
 *  🔴 WHAT THIS REPLACES, because the shape of the old bug is the whole point.
 *  The standalone path below asks `listByShortCode(code)` — the one PC lookup
 *  in this repo with no user dimension — and takes the newest ACTIVE row. On a
 *  single-machine deployment that is exactly right (there is one user). On the
 *  multi-tenant relay it meant the 4-digit code was the ONLY addressing the
 *  protocol had (short-code.ts says so in its own words), so a guessed code
 *  paired the guesser with whichever stranger happened to be pairing right
 *  then. One value was answering two questions — 「which PC」 and 「prove it」 —
 *  which is this repo's #1 documented defect shape.
 *
 *  ORDER IS LOAD-BEARING: address, then secret. Resolving the row first means
 *  the code is checked against ONE row's own issuance instead of probing a
 *  shared namespace, and it gives a wrong guess a victim to be charged to (see
 *  the recordFailedGuess call below, and IT-39-a in short-code.ts for why 「who
 *  pays」 was previously a heuristic).
 *
 *  WHAT DOES NOT CHANGE: the code keeps every limit it had (5-minute TTL,
 *  per-issuance failure budget, per-IP window in pair-rate-limit.ts). A PCID is
 *  public addressing — it is not a second factor and must never be described as
 *  one. */
function resolvePcByPcid(deps: PairResolveDeps, codes: ShortCodeGovernor, pcid: string | undefined, code: string): PcRecord {
  // ① No PCID at all — the refusal owner's ruling exists to produce. It fires
  // BEFORE any lookup and before any failure accounting: nothing about this
  // frame probed the code space, so charging it would let a malformed client
  // burn a stranger's live code for free (the same reasoning that keeps the
  // malformed-input throws above the charge site on the standalone path).
  //
  // 🔴 This is the one refusal on this path the USER CAN FIX, so it must stay a
  // code of its own — the phone force-shows its PCID field on seeing it, which
  // is what rescues a user whose endpoint heuristic guessed 「LAN」 wrongly
  // (apps/mobile/lib/src/ui/add_pairing_sheet.dart).
  if (!pcid) throw new ServerError('PAIR_PCID_REQUIRED', 'cloud pairing requires a pcid');
  // ② Shape and existence collapse into ONE answer deliberately. Both mean
  // 「that PCID does not name a PC」 and both are fixed by the same action
  // (re-read the number on the PC); splitting them would only tell a prober
  // which of their guesses were well-formed.
  if (!PCID_RE.test(pcid)) throw new ServerError('PAIR_PCID_UNKNOWN', 'malformed pcid');
  const pc = deps.pcs.findByPcid(pcid);
  // `isRealPc` is load-bearing here for the same reason it is on the standalone
  // path: the F-3140 cloud-instance row must never be reachable by address.
  // Today it cannot even hold a pcid (stampPcid skips it), so this is a belt
  // on top of braces — kept because the cost is one call and the failure it
  // prevents is 「a phone pairs with a virtual PC that has no focus window」.
  if (!pc || !isRealPc(pc)) throw new ServerError('PAIR_PCID_UNKNOWN', 'no pc for pcid');
  // ③ Now, and only now, the secret — checked against THIS row's own issuance.
  const matches = pc.short_code === code;
  if (matches && codes.isActive(pc.id)) return pc;
  // A miss. Charge it to the PC that was actually attacked: unlike the
  // standalone path, a guess here CARRIES its victim, so IT-39-a's
  // "most-exposed live issuance" heuristic is not needed and not used. One
  // consequence worth stating: a sprayer can now aim a burn at a PC whose PCID
  // they know, where before they could not aim at all — but they can only ever
  // burn the code of the PC they name, never a bystander's, and the cure is
  // unchanged (press "refresh"). The cross-tenant blast radius IT-39-a was written
  // to bound is gone from this path entirely, because a bare code no longer
  // reaches a lookup at all (it dies at ① above).
  codes.recordFailedGuess(pc.id);
  // Same two-value vocabulary as the standalone path, same reasoning: the code
  // this row is CURRENTLY showing but which is no longer live (TTL lapsed,
  // governor restarted, or burned) is 「expired, refresh it」; anything else is
  // 「that code is not this PC's」. Burned vs expired stay indistinguishable on
  // the wire on purpose — see the long note on the standalone path.
  if (matches) throw new ServerError('PAIR_EXPIRED_CODE', 'code was issued but its active window lapsed');
  throw new ServerError('PAIR_INVALID_CODE', 'code does not match this pc');
}
