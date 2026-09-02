// SPEC-REF:
//   OPS-1 (production investigation, 2026-09-02) — the socket-level auth path
//   (`auth/middleware.ts`'s `authMiddleware`/`resolveHandshakeJwt`/opaque-token
//   resolution, and the handler-level token checks in
//   `socket/handlers/{pc,mobile}.handler.ts`) had ZERO log calls on any refusal
//   branch. When a phone's handshake or a `pc:reconnect`/`mobile:reconnect` ack
//   came back AUTH_TOKEN_INVALID / AUTH_TOKEN_EXPIRED / AUTH_TOKEN_UNVERIFIABLE /
//   ACCOUNT_RESTRICTED, production logs showed nothing at all — an iOS P0 on
//   2026-09-02 could not be attributed server-side because there was no line to
//   read. This file is the ONE place a refusal becomes a log line, so every
//   call site's line has the same shape and a future incident greps one
//   function instead of four call sites that each spelled the fields
//   differently.
//
// WHAT THIS NEVER LOGS: the token/JWT itself, or an email address. `redactToken`
// keeps exactly the first 3 characters — enough to tell two refusals on the
// SAME credential apart across log lines (a reconnect storm) without ever
// writing a credential, or enough of one to guess, to a file that outlives the
// process (log.ts's FLOWMIC_LOG_PATH).
//
// SUPPRESSION, AND WHY IT IS ONE SHARED MAP. A phone retrying a dead token
// reconnects every few seconds; unthrottled, that is one log line per retry
// forever. `AuthRefusalLog` remembers, per (token-prefix, code) pair, the last
// time that pair was logged, and drops a repeat within `SUPPRESS_WINDOW_MS`.
// The exported `authRefusalLog` instance is a SINGLE process-wide map,
// deliberately shared by every call site (the handshake middleware AND the
// pc:reconnect/mobile:reconnect event handlers) — a storm hammering the
// handler-level path must still be bounded by the same window the handshake
// path already spent, or the two paths would each get their own private 60 s
// budget and the total volume would double for no reason.
//
// This does NOT change any refusal semantics — every call site still returns
// exactly the code it returned before this file existed. `refuse()` only
// decides whether a LINE gets written; it never touches `next()`/`safeAck()`.

import { log } from '../log';

/** Free-form on purpose (not a closed union): a new call site names its own
 *  decision point without editing this file. The four points OPS-1 asked for
 *  are `handshake-jwt`, `handshake-token`, `pc:reconnect`, `mobile:reconnect`
 *  (plus the restricted-account admissions, `mobile:pair` / `mobile:reconnect`
 *  / `mobile:cloud-instance`) — see the call sites in `middleware.ts` and the
 *  two handler files for the exact string each one uses. */
export type AuthRefusalWhere = string;

export interface AuthRefusalFields {
  /** The registered `ErrorCode` the caller is about to answer with
   *  (`next(new Error(code))` on the handshake, `safeAck(ack, {error: code})`
   *  on an event ack). A plain string, not `ErrorCode`, so this file does not
   *  have to import the whole protocol enum just to log one of its members. */
  code: string;
  /** Which decision point refused — see `AuthRefusalWhere`. */
  where: AuthRefusalWhere;
  /** Unknown at some decision points (e.g. the handshake JWT check runs before
   *  the opaque token — pc vs mobile vs web — is resolved at all). */
  kind?: 'pc' | 'mobile' | 'web' | null;
  /** This node's id (`nodeConfig.nodeId`), or null/absent on a single-node
   *  deployment — there is no second node to name there. */
  node?: string | null;
  /** The RAW credential (opaque device/mobile token, or the account JWT) —
   *  NEVER logged whole. Only `redactToken(token)` travels into the line. */
  token?: string | null;
  /** Present only when the refusal itself resolved an identity (e.g. a
   *  restricted-account check, which by definition already knows the user).
   *  Never an email — callers must not pass one. */
  userId?: string | null;
}

/** How long one (token-prefix, code) pair stays suppressed after it logs. */
const SUPPRESS_WINDOW_MS = 60_000;

/** First 3 characters of a token/JWT, or a fixed placeholder when there is no
 *  credential to name at all (a handshake that presented none). Exported so a
 *  test can compute the same prefix it expects to read back out of the log
 *  line, instead of re-deriving "first 3 chars" by hand. */
export function redactToken(token: string | null | undefined): string {
  if (token === null || token === undefined || token.length === 0) return '(none)';
  return token.slice(0, 3);
}

/**
 * The suppression window, as a class rather than bare module state so a test
 * can hold its OWN instance with an injected clock — see
 * `auth-refusal-log.test.ts` — instead of racing `Date.now()` against a real
 * 60-second sleep. Production uses exactly one instance: `authRefusalLog`
 * below.
 */
export class AuthRefusalLog {
  private readonly lastLoggedAtMs = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Log one refusal unless the same (token-prefix, code) pair already logged
   * within `SUPPRESS_WINDOW_MS`. Returns whether it actually wrote a line —
   * tests use the return value to pin the suppression boundary without
   * reaching into the private map.
   */
  refuse(fields: AuthRefusalFields): boolean {
    const prefix = redactToken(fields.token);
    const key = `${prefix}|${fields.code}`;
    const t = this.now();
    const last = this.lastLoggedAtMs.get(key);
    if (last !== undefined && t - last < SUPPRESS_WINDOW_MS) return false;
    this.lastLoggedAtMs.set(key, t);
    log.warn('auth: refused', {
      code: fields.code,
      where: fields.where,
      kind: fields.kind ?? null,
      node: fields.node ?? null,
      token_prefix: prefix,
      ...(fields.userId ? { user_id: fields.userId } : {}),
    });
    return true;
  }

  /** Test-only: forget every suppression timestamp. Exposed (same precedent as
   *  `room/pc-absence.ts`'s `drainForTests()`) because `authRefusalLog` below
   *  is a shared singleton and tests that reuse a token string across `it()`
   *  blocks in one file would otherwise suppress each other's assertions. */
  resetForTests(): void {
    this.lastLoggedAtMs.clear();
  }
}

/** The ONE instance every production call site shares — see the header's
 *  SUPPRESSION note for why this must be a single map, not one per file. */
export const authRefusalLog = new AuthRefusalLog();

/** Convenience wrapper over the shared singleton. Production call sites import
 *  THIS, not `AuthRefusalLog` directly, so nobody accidentally constructs a
 *  second instance whose suppression window cannot see the first one's. */
export function logAuthRefusal(fields: AuthRefusalFields): void {
  authRefusalLog.refuse(fields);
}
