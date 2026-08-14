// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:release-mobile / mobile:reconnect)
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-08 (semantic split in two)
//   *** HUMAN-AUDIT SENSITIVE (auth/pairing) — reviewable in isolation ***
//
// GA-08 "Disconnect" is only a real action if the phone STAYS gone for a moment.
//
// Before this module, `pc:release-mobile` disconnected the mobile socket and
// nothing else: the pairing row and its token were untouched, so the phone's
// reconnect ladder (mobile/reconnect.dart) was back in the room within seconds.
// A button that undoes itself is worse than no button — the owner believes the
// phone is off and it is not.
//
// So a release now also parks the pairing id here for RELEASE_SUPPRESS_MS. A
// `mobile:reconnect` carrying that pairing's (still perfectly valid) token is
// refused with PAIR_RELEASED for the length of the window and then flows again
// on its own. Deliberately NOT a revocation: nothing is deleted, no token dies,
// and the phone needs no user action to come back — "Unpair" is the other button.
//
// TWO properties the design leans on:
//   · IN-MEMORY ONLY. A window is scoped to one server lifetime; a restart drops
//     every entry and phones may return at once. That is the intended
//     disposition — "Disconnect" ends a SESSION, and a server restart already ended
//     every session. Persisting a 60 s grudge across a restart would outlive the
//     thing it was about (and 05 has no table for it — a schema change for one
//     minute of state is the wrong trade).
//   · LAZY EXPIRY + PRUNE. Nothing schedules a timer: `remainingMs` compares to
//     the injected clock and drops dead entries as it passes them, so tests run
//     on a fake clock with no sleeping and the map cannot grow without bound.

/** 04 §3.1 GA-08: how long a released pairing is held out of the room. Long
 *  enough that the owner sees the phone actually leave (the ladder's backoff is
 *  seconds), short enough that "Disconnect" never feels like "Unpair". */
export const RELEASE_SUPPRESS_MS = 60_000;

/** GA-29 "the capsule is occupied" hold-out. A busy refusal is NOT an operator action — the
 *  PC is simply occupied — so the phone must be able to come back the moment the
 *  other one leaves. Long enough that the ladder backs off once instead of
 *  hammering, short enough that a freed capsule is usable within a breath. */
export const BUSY_SUPPRESS_MS = 8_000;

/** Why a pairing is being held out. The code travels to the phone verbatim, so
 *  the two reasons produce two DIFFERENT sentences: "the computer just
 *  disconnected this phone"
 *  (someone pressed Disconnect) vs "another phone is already in use" (nobody pressed anything). */
export type SuppressReason = 'manual' | 'busy';

interface Entry {
  until: number;
  reason: SuppressReason;
}

export class ReleaseSuppression {
  /** pairing_id → when the phone may return + why it is being held. */
  private readonly until = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = RELEASE_SUPPRESS_MS,
    private readonly busyWindowMs: number = BUSY_SUPPRESS_MS,
  ) {}

  /** Start (or restart) the window for one pairing. Returns the window length so
   *  the caller can report `retry_after_ms` truthfully rather than guessing. */
  suppress(pairingId: string, reason: SuppressReason = 'manual'): number {
    const ms = reason === 'busy' ? this.busyWindowMs : this.windowMs;
    this.until.set(pairingId, { until: this.now() + ms, reason });
    return ms;
  }

  /** Milliseconds left, or 0 when the pairing is free to return. Prunes the
   *  entry it just found to be expired (the only cleanup this class needs). */
  remainingMs(pairingId: string): number {
    const entry = this.until.get(pairingId);
    if (entry === undefined) return 0;
    const left = entry.until - this.now();
    if (left <= 0) {
      this.until.delete(pairingId);
      return 0;
    }
    return left;
  }

  /** Why this pairing is held out, or `null` when it is free. Read together with
   *  [`remainingMs`] so an expired entry can never yield a stale reason. */
  reasonFor(pairingId: string): SuppressReason | null {
    if (this.remainingMs(pairingId) <= 0) return null;
    return this.until.get(pairingId)?.reason ?? null;
  }

  isSuppressed(pairingId: string): boolean {
    return this.remainingMs(pairingId) > 0;
  }

  /** Forget a pairing. Called when the row is REVOKED: the token is dead, so a
   *  suppression entry for it would only be a leak (and, if the same id were ever
   *  minted again, a lie about a pairing that no longer exists). */
  clear(pairingId: string): void {
    this.until.delete(pairingId);
  }

  /** Live entry count (tests + observability). Expired-but-unpruned entries are
   *  counted — this is the map size, not a claim about who is suppressed. */
  get size(): number {
    return this.until.size;
  }
}
