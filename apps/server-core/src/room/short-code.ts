// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pairing short code + refresh)
//   docs/rebuild/13-LESSONS-LEARNED.md §2 (short-code TTL / active-only lookup)
//   Ported mechanism from legacy room/short-code-governor.ts + active-short-code.ts.
//
// A 4-digit pairing code is only valid while ACTIVE (issued within the TTL). A
// stale code that a different PC later re-mints must never resolve to the old
// PC. The governor tracks issuance time per PC and reserves codes to avoid
// active collisions.
//
// IT-39 (0.3.0) — an ISSUANCE also has a FAILURE BUDGET, not only a TTL.
// *** HUMAN-AUDIT SENSITIVE (pairing/auth) *** The per-IP window in
// pair-rate-limit.ts bounds one SOURCE; nothing bounded the TARGET, so an
// attacker who rotates source addresses could spend more guesses inside one
// 5-minute window than the code space holds. `recordFailedGuess` is the missing
// axis: how many wrong guesses this issuance has absorbed, counted on the
// attacked side. See that method for which issuance is charged and why.
//
// IT-39-a (0.3.0) — that budget must not become a CROSS-TENANT weapon. A wrong
// guess carries no target, so the first cut charged EVERY live issuance on every
// miss; on the MULTI-TENANT relay that let one sprayer burn the code of every
// currently-pairing user at once (20 guesses, all codes worldwide dead — a
// trivial availability attack). `recordFailedGuess` now charges ONE live
// issuance per guess (the most-exposed one, `mostExposedLiveIssuance`), so a
// burst burns at most ONE code and every other tenant keeps its full budget. The
// single-code brute-force property is unchanged (with one live code it is always
// the one chosen). See that method for the full reasoning and the residual.

import { randomInt } from 'node:crypto';
import { log } from '../log';

/** The code space, stated once so the brute-force arithmetic has a symbol to
 *  cite instead of a number retyped in three files: `randomShortCode` draws
 *  uniformly from [0, 10_000) and zero-pads to 4 DIGITS, so the alphabet is
 *  0-9, the length is 4, and the space is exactly 10^4. Pinned (alphabet and
 *  bounds, by sampling) in test/pair-code-budget.test.ts. */
export const SHORT_CODE_SPACE = 10_000;

/** IT-39 plan A — total failed pairing guesses ONE ISSUANCE of a short code may
 *  absorb before it is burned for the rest of its life.
 *
 *  🔴 PROVENANCE OF THIS NUMBER — it is NOT an owner ruling. owner 2026-08-06
 *  ruled the AXIS (D8 in docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md:
 *  "Option A: each code carries its own total budget"). The value 20 is a
 *  SUGGESTION made by the proposing window
 *  (docs/strategy/2026-08-06-it39-pairing-bruteforce-proposal.md, verbatim
 *  "suggest N=20") and carried forward unchanged by the implementing window, which
 *  had no owner instruction about the number either. Nobody has ruled that it
 *  must be 20; it is tunable on evidence, and citing this constant as 「owner
 *  said 20」 would be inventing a ruling.
 *
 *  Why a number in this range at all: a human mistypes a 4-digit code once or
 *  twice, never twenty times — and 20 out of a 10^4 space caps the probability
 *  that any single issuance is ever guessed at 20/10^4 = 0.2 %, regardless of how
 *  many source addresses the attacker owns. */
export const SHORT_CODE_FAILURE_BUDGET = 20;

export function randomShortCode(): string {
  return String(randomInt(0, SHORT_CODE_SPACE)).padStart(4, '0');
}

export interface ShortCodeLookup {
  listByShortCode(code: string): { id: string; short_code: string; created_at: string }[];
}

export class ShortCodeAllocationError extends Error {}

export class ShortCodeGovernor {
  private readonly issuedAt = new Map<string, number>(); // pcId → ms
  private readonly reserved = new Map<string, string>(); // code → owner pcId
  private readonly codeByPc = new Map<string, string>(); // pcId → code
  /** IT-39: pcId → failed guesses charged to its CURRENT issuance. Same key set
   *  and same lifetime as `issuedAt` — reset by `stamp` (a new issuance is a new
   *  budget) and dropped by `releaseExpired`, so it adds no growth surface of
   *  its own. */
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly pcs: ShortCodeLookup,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
    private readonly failureBudget = SHORT_CODE_FAILURE_BUDGET,
  ) {}

  allocate(ownerId?: string): string {
    this.releaseExpired();
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = randomShortCode();
      const clashes = this.pcs.listByShortCode(code);
      const reservedBy = this.reserved.get(code);
      const activeClash = clashes.some((c) => c.id !== ownerId && this.isActive(c.id));
      if (!activeClash && (!reservedBy || reservedBy === ownerId)) {
        this.reserved.set(code, ownerId ?? `pending:${code}`);
        return code;
      }
    }
    throw new ShortCodeAllocationError('short-code allocation exhausted');
  }

  stamp(pcId: string, code: string): void {
    const previous = this.codeByPc.get(pcId);
    if (previous && previous !== code && this.reserved.get(previous) === pcId) this.reserved.delete(previous);
    this.reserved.set(code, pcId);
    this.codeByPc.set(pcId, code);
    this.issuedAt.set(pcId, this.now());
    // IT-39: a new issuance starts with a full budget. This is the ONE recovery
    // path out of a burn, and it is the path the user already has — re-register
    // or "refresh pairing code" (registry.refreshShortCode / registerPc's existing branch).
    this.failures.delete(pcId);
  }

  isActive(pcId: string): boolean {
    const issued = this.issuedAt.get(pcId);
    if (issued === undefined || this.now() - issued >= this.ttlMs) return false;
    // IT-39: a burned issuance is dead for the REST of its life, exactly as if
    // its TTL had run out early. Deciding it here rather than at the call sites
    // is the whole point: `findActivePcByCode`, `allocate`'s clash check and
    // `remainingMs` must never be able to disagree about whether a code is live.
    return !this.isBurned(pcId);
  }

  /** IT-39: has this PC's current issuance spent its failure budget? Separate
   *  from `isActive` so a caller that needs to tell "burned" from "expired" can,
   *  without re-deriving the rule. */
  isBurned(pcId: string): boolean {
    return (this.failures.get(pcId) ?? 0) >= this.failureBudget;
  }

  /** IT-39 — charge ONE failed pairing guess against the code space.
   *
   *  🔴 WHICH ISSUANCE IS CHARGED (IT-39-a corrected the answer).
   *  A wrong guess carries no victim in it: it matched no row, so there is no
   *  pcId to attribute it to. Charging the GUESSED STRING instead would be
   *  perfectly attributable and completely useless — an attacker walking the
   *  space guesses each string ONCE, so no string would ever reach a budget of
   *  2, let alone 20. The quantity that actually bounds the attack is the one
   *  the proposal named: "how many times, in total, has this code been guessed
   *  wrong" — the exposure of a LIVE
   *  issuance, counted on the attacked side. So a miss must be charged to a live
   *  issuance; the only question left is HOW MANY of them.
   *
   *  🔴 ONE live issuance per guess, not EVERY one. The first cut of this method
   *  charged EVERY live issuance on every miss. On a SINGLE-MACHINE deployment
   *  that is exactly right — there is only ever one user, so 「every live
   *  issuance」 is 「this user's own codes」 and the old comment (「WHY IT IS EVERY
   *  LIVE ONE」) was accurate there. On the MULTI-TENANT cloud relay it is an
   *  availability attack: one attacker spraying the relay burns the budget of
   *  EVERY PC of EVERY tenant that happens to be showing its pairing dialog right
   *  then — 20 guesses, all live codes worldwide dead. So a miss is now charged
   *  to a SINGLE live issuance: `mostExposedLiveIssuance()`, the one already
   *  closest to its own burn. This CONCENTRATES a spray onto one code and
   *  finishes it, rather than SPREADING one guess across all of them:
   *    · the single-code property IT-39 bought is UNCHANGED — with one live code
   *      it is always the one chosen, so N misses burn it exactly as before
   *      (pair-code-budget.test.ts; pair-brute-force-e2e.test.ts DIRECTION 2);
   *    · the blast radius of a burst of N guesses is now ONE code; every other
   *      tenant keeps its FULL budget (a burst only reaches the next code once
   *      the first is burned and drops out of `isActive`). Pinned, with a reverse
   *      control, by pair-tenant-blast-radius-e2e.test.ts.
   *
   *  WHICH single one, and why the attacker cannot aim it: the live issuance with
   *  the most accumulated failures, ties broken by the oldest (issuedAt is
   *  insertion-ordered). A guess carries no target, so the victim of a burn is
   *  chosen by the SERVER, never by the attacker — they cannot aim a burn at a
   *  specific tenant (they already cannot aim a PAIR at one: the code is the only
   *  addressing the protocol has, and they do not know it).
   *
   *  RESIDUAL, so nobody has to rediscover it: this does NOT make a SUSTAINED
   *  spray harmless — K·N guesses still burn K codes, one after another (the
   *  charge rolls to the next-most-exposed code each time the leader burns). That
   *  residual is the price the proposal quoted before owner took Option A ("when
   *  an attack really happens, a user in the middle of pairing may have to
   *  rescan a new code — that is exactly what the protection working looks
   *  like"); one address is
   *  still bounded to ~10 misses/60 s. What IT-39-a removes is the ALL-AT-ONCE
   *  cross-tenant multiplier, not the denial itself — without any budget the same
   *  attacker eventually STEALS a pairing; with it the most they buy is making
   *  users press "refresh" while they keep paying.
   *
   *  ⚠️ NOT charged: a malformed guess that never reaches the lookup (see
   *  registry.resolvePcForPair — the `/^\d{4}$/` and qr-payload rejections throw
   *  before the code space is probed). A space walk cannot use those, and
   *  counting them would let junk burn codes for free. */
  /** @param attackedPcId 0.2.66 — the PC the guess NAMED, when it named one.
   *
   *  🔴 THIS PARAMETER DELETES A HEURISTIC RATHER THAN ADDING ONE. Everything
   *  above — 「a wrong guess carries no victim in it」, `mostExposedLiveIssuance`,
   *  IT-39-a's blast-radius reasoning — is downstream of a single fact about the
   *  OLD protocol: a bare 4-digit code did not say which PC it was aimed at, so
   *  the server had to CHOOSE a victim. Since 0.2.66 a cloud pairing frame
   *  carries a PCID, so on that path the victim is no longer a guess: the caller
   *  (registry.resolvePcByPcid) has already resolved the exact row the code was
   *  checked against, and passes it here.
   *
   *  When it is supplied the charge is exact, and IT-39-a's cross-tenant problem
   *  cannot arise on that path at all — not because the heuristic got better, but
   *  because a bare code no longer reaches a lookup (it is refused with
   *  PAIR_PCID_REQUIRED before this method is reachable).
   *
   *  When it is ABSENT the behaviour is byte-for-byte what it was: the standalone
   *  path still calls this with nothing, because a LAN deployment has no PCID and
   *  its single-user situation is the one `mostExposedLiveIssuance` was always
   *  correct for.
   *
   *  ⚠️ A named PC with no live issuance is charged NOTHING — the same shape as
   *  `target === null` below. Its code cannot be burned because it has no code;
   *  guessing at a PC that is not currently pairing must not accumulate anything
   *  for its next issuance to inherit. */
  recordFailedGuess(attackedPcId?: string): void {
    this.releaseExpired(); // keep the scan over live issuances, not stale ones
    const target =
      attackedPcId !== undefined
        ? this.isActive(attackedPcId)
          ? attackedPcId
          : null
        : this.mostExposedLiveIssuance();
    if (target === null) return; // nothing is pairing right now — no code to charge
    const now = this.now();
    const next = (this.failures.get(target) ?? 0) + 1;
    this.failures.set(target, next);
    if (next >= this.failureBudget) {
      // Fires exactly once per issuance: at the budget-th miss the issuance
      // becomes !isActive (isBurned), so `mostExposedLiveIssuance` skips it on
      // the next guess and the charge rolls to the next-most-exposed code. A user
      // WILL report this as "the code suddenly stopped working", and without a line
      // there is nothing to diagnose it with — the phone's refusal says "expired" and cannot say
      // why (no protocol field carries it).
      log.warn('short_code.burned', {
        pc_id: target,
        failed_guesses: next,
        budget: this.failureBudget,
        issuance_age_ms: now - (this.issuedAt.get(target) ?? now),
      });
    }
  }

  /** IT-39-a — the single live issuance a wrong guess is charged to: the one
   *  already closest to its burn (the most accumulated failures), ties broken by
   *  the OLDEST issuance (issuedAt is a Map in insertion = registration order, so
   *  the first key seen wins a tie). null when no issuance is live. Concentrating
   *  the charge on the leader is what keeps a burst's blast radius at ONE code
   *  instead of every live one (see recordFailedGuess); a burned issuance is
   *  !isActive, so it is never selected again and the charge rolls to the next. */
  private mostExposedLiveIssuance(): string | null {
    let bestId: string | null = null;
    let bestFailures = -1;
    for (const pcId of this.issuedAt.keys()) {
      if (!this.isActive(pcId)) continue; // expired, or already burned
      const failures = this.failures.get(pcId) ?? 0;
      if (failures > bestFailures) {
        bestFailures = failures;
        bestId = pcId;
      }
    }
    return bestId;
  }

  /** GA-18: milliseconds this PC's code is still ACTIVE for, or 0 when there is
   *  no live issuance. The governor already owns the TTL, so the countdown the
   *  pairing modal shows is read from the same clock that decides
   *  `isActive` — a second TTL constant in the UI would be the classic drift
   *  (a code that visibly "expires" while still pairing, or the reverse). */
  remainingMs(pcId: string): number {
    const issued = this.issuedAt.get(pcId);
    if (issued === undefined) return 0;
    // IT-39: a burned issuance has no lifetime left to report. 0 here and
    // `isActive` false are the SAME fact; letting the countdown outlive the gate
    // would put two answers on "is this code still usable" (R11).
    // ⚠️ OPEN ACCOUNT, not a claim: this value reaches the desktop only as a
    // SNAPSHOT in the pc:register / pc:refresh-code ack, so a burn that happens
    // afterwards cannot reach the modal — the dialog keeps counting down over a
    // dead code. Telling it would need a server→PC push carrying a short code,
    // and no such event exists (protocol has none; adding one is an owner gate).
    // The honest answer still lands where it matters: the PHONE is refused.
    if (this.isBurned(pcId)) return 0;
    const left = issued + this.ttlMs - this.now();
    return left > 0 ? left : 0;
  }

  private releaseExpired(): void {
    for (const [pcId, issued] of this.issuedAt) {
      if (this.now() - issued < this.ttlMs) continue;
      const code = this.codeByPc.get(pcId);
      if (code && this.reserved.get(code) === pcId) this.reserved.delete(code);
      this.codeByPc.delete(pcId);
      this.issuedAt.delete(pcId);
      this.failures.delete(pcId); // IT-39: never outlive the issuance it counts
    }
  }
}

/** Resolve a code to the single ACTIVE PC that currently owns it. Among rows
 *  sharing a code (a stale re-mint), only an active issuance counts. */
export function findActivePcByCode<T extends { id: string; short_code: string; created_at: string }>(
  rows: T[],
  isActive: (pcId: string) => boolean,
): T | null {
  const active = rows.filter((r) => isActive(r.id));
  if (active.length === 0) return null;
  // Newest active wins (created_at DESC ordering from the repo).
  return active[0] as T;
}
