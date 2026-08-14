// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 (account JWT)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-31
//   docs/decisions/2026-07-26-web-login-qr.md
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// QR-code login — a one-time, short-lived grant that lets a phone join an account by
// scanning a QR the ALREADY-SIGNED-IN web console draws, instead of typing an
// email and password on a phone keyboard.
//
// WHAT THIS THING ACTUALLY IS: a bearer credential in visual form. For as long as
// a grant lives, anyone who can photograph the screen can take the account. The
// whole design is therefore about making that window as small and as narrow as it
// can be while still being usable:
//
//   · MINTED ONLY BY AN AUTHENTICATED CONSOLE. The nonce is bound to the user id
//     at mint time, so redeeming it can never name a different account;
//   · 60 SECONDS. Long enough to unlock a phone and aim a camera, short enough
//     that a screenshot in a chat log is worthless by the time anyone reads it;
//   · SINGLE USE. Redeeming deletes the grant before the token is issued, so a
//     replay — including a concurrent one — finds nothing;
//   · 128 BITS of CSPRNG entropy. Not guessable, and not derived from anything
//     about the user;
//   · NO ORACLE. Unknown, expired and already-used are ONE outcome with ONE
//     message. A caller must not be able to learn that a nonce once existed;
//   · NEVER LOGGED. The nonce is the credential; a log line carrying it is the
//     same leak as a log line carrying a password.
//
// IN MEMORY ON PURPOSE. A grant is scoped to one server lifetime — a restart
// invalidates every pending QR, which is the correct disposition for a 60-second
// credential (and 05 has no table for it; a schema change for one minute of state
// is the wrong trade, same reasoning as ReleaseSuppression).

import { randomBytes } from 'node:crypto';

/** How long a drawn QR stays redeemable. */
export const QR_GRANT_TTL_MS = 60_000;
/** Nonce entropy. 16 bytes = 128 bits, hex-encoded to 32 chars. */
const NONCE_BYTES = 16;
/** Hard cap on live grants, so a script hammering the mint route cannot grow the
 *  map without bound. Oldest-first eviction: a fresh QR always wins over a stale
 *  one the user has already walked away from. */
const MAX_LIVE_GRANTS = 1_000;

interface Grant {
  userId: string;
  expiresAt: number;
}

export class QrGrantStore {
  private readonly grants = new Map<string, Grant>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = QR_GRANT_TTL_MS,
    /** Injectable ONLY so tests can pin a nonce; production always uses the
     *  CSPRNG default. */
    private readonly mintNonce: () => string = () => randomBytes(NONCE_BYTES).toString('hex'),
  ) {}

  /** Mint a grant for an authenticated user. Returns the nonce and its life. */
  issue(userId: string): { nonce: string; expires_in_ms: number } {
    this.prune();
    if (this.grants.size >= MAX_LIVE_GRANTS) {
      // Map iteration is insertion-ordered, so the first key is the oldest.
      const oldest = this.grants.keys().next();
      if (!oldest.done) this.grants.delete(oldest.value);
    }
    const nonce = this.mintNonce();
    this.grants.set(nonce, { userId, expiresAt: this.now() + this.ttlMs });
    return { nonce, expires_in_ms: this.ttlMs };
  }

  /** Redeem a nonce ONCE. Returns the user id it was minted for, or null.
   *
   *  The delete happens BEFORE the caller issues a token, so two simultaneous
   *  redemptions cannot both succeed — the loser sees exactly what a stranger
   *  with a made-up nonce sees. */
  redeem(nonce: string): string | null {
    const key = typeof nonce === 'string' ? nonce.trim() : '';
    if (key === '') return null;
    const grant = this.grants.get(key);
    if (grant === undefined) return null;
    this.grants.delete(key);
    // Checked AFTER the delete: an expired grant is consumed too, so it cannot
    // linger and cannot be probed a second time.
    if (grant.expiresAt <= this.now()) return null;
    return grant.userId;
  }

  /** Whether a grant is still live — TEST/observability only. Deliberately not
   *  reachable from any route: exposing it would be the existence oracle the
   *  redeem path is careful not to be. */
  isLive(nonce: string): boolean {
    const g = this.grants.get(nonce);
    return g !== undefined && g.expiresAt > this.now();
  }

  get size(): number {
    return this.grants.size;
  }

  /** Drop expired entries. Lazy (called on mint) — nothing schedules a timer, so
   *  tests run on a fake clock with no sleeping. */
  private prune(): void {
    const t = this.now();
    for (const [nonce, g] of this.grants) {
      if (g.expiresAt <= t) this.grants.delete(nonce);
    }
  }
}

/** The exact link the console encodes. Kept here, next to the store, so the two
 *  ends of the format cannot drift; the mobile parser mirrors it in
 *  `ui/scan_payload.dart` (`flowmic://login`). */
export function buildLoginLink(endpoint: string, nonce: string): string {
  return `flowmic://login?endpoint=${endpoint}&t=${nonce}`;
}
